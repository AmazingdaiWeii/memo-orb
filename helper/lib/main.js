import { BrowserWindow, Menu, Tray, app, clipboard, dialog, ipcMain, nativeImage, nativeTheme, screen, shell } from "electron";
import { request } from "node:http";
import { createConnection } from "node:net";
import { fileURLToPath } from "node:url";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
// 环菜单几何的**唯一真源**在 assets/ring-geometry.js（纯函数，可被 node 直接 import 断言）。
// 下面 RING_* 三个字面量是给探针做交叉校验用的镜像，改这里必须同步改那边。
import { ringLayout, visibleItemArc } from "../assets/ring-geometry.js";

//#region src/avatar.ts
/**
* Avatar messages from the host.
* The host owns what the avatar is; the helper only turns that into something the
* ball page can load: a relative asset path, the uploaded bytes, or nothing (the
* GIF that ships with the page).
*/
/** `kind: 'preset'` sources: a plain relative GIF path, never a URL scheme or a parent hop. */
const PRESET_SRC$1 = /^[a-z0-9][a-z0-9_-]*(?:\/[a-z0-9_-]+)*\.gif$/;
function readAvatarChoice(record) {
	if (record.kind === "preset" && typeof record.src === "string" && PRESET_SRC$1.test(record.src)) return {
		kind: "preset",
		src: record.src
	};
	const version = typeof record.version === "number" && Number.isFinite(record.version) ? Math.trunc(record.version) : 0;
	if (record.kind === "custom" && version > 0) return {
		kind: "custom",
		version
	};
	return { kind: "default" };
}

//#endregion
//#region src/chrome-windows.ts
/**
* One native window id from an Electron handle buffer.
* A Windows `HWND` is pointer sized. The host compares this value against the ids its own
* `EnumWindows` walk produces, which are the same pointer values as JS numbers.
* @param handle - buffer from `getNativeWindowHandle`.
* @returns the id, or undefined when the buffer is too small or holds no usable id.
*/
function windowIdFromHandle(handle) {
	const id = handle.length >= 8 ? Number(handle.readBigUInt64LE(0)) : handle.length >= 4 ? handle.readUInt32LE(0) : NaN;
	if (!Number.isSafeInteger(id) || id <= 0) return void 0;
	return id;
}
/**
* Ids for the helper's chrome windows, for the host's capture exclusion list.
* @param windows - ball, selection toolbar, and observation frame; any may be missing.
* @param platform - the helper's `process.platform`.
* @returns unique ids, empty on every platform other than Windows.
*/
function collectChromeWindowIds(windows, platform) {
	if (platform !== "win32") return [];
	const ids = [];
	for (const window of windows) {
		if (window === void 0) continue;
		let id;
		try {
			id = windowIdFromHandle(window.getNativeWindowHandle());
		} catch {
			id = void 0;
		}
		if (id !== void 0 && !ids.includes(id)) ids.push(id);
	}
	return ids;
}

//#endregion
//#region src/geometry.ts
/**
* Floating-ball window geometry.
* Sizes match the fork overlay exactly: a 72px ball, 12px of transparent chrome, and a 320×420 panel.
*
* 独立版改造（2026-10-06）：面板尺寸从「编译期常量」变成「运行时状态」。
* 原因：用户要求对话窗口能随意调整大小。原先PANEL_SIZE 是 const，
* 被 overlayBoundsFromBall / expandDirection / setExpanded / move 全都直接引用，
* 任何 resize 都会被这些地方用常量重算覆盖掉。
* 现在统一走 {@link PanelSize} 状态对象，由 FloatingPlacement 持有并对外同步。
*/
const BALL_SIZE = 72;
const CHROME_INSET = 12;
/** 默认值 = 原常量，一像素没改，保证首次启动的视觉与旧版完全一致。 */
const PANEL_SIZE_DEFAULT = {
	width: 320,
	height: 420
};
/** 拖拽下限。再小就放不下输入框了。 */
const PANEL_SIZE_MIN = {
	width: 280,
	height: 320
};
/** 拖拽上限。留出余量，避免窗口比显示器工作区还大导致无法吸附。 */
const PANEL_SIZE_MAX = {
	width: 900,
	height: 1200
};
function clampPanelSize(size, workArea) {
	const maxW = workArea ? Math.max(PANEL_SIZE_MIN.width, Math.min(PANEL_SIZE_MAX.width, workArea.width - 2 * CHROME_INSET)) : PANEL_SIZE_MAX.width;
	const maxH = workArea ? Math.max(PANEL_SIZE_MIN.height, Math.min(PANEL_SIZE_MAX.height, workArea.height - 2 * CHROME_INSET)) : PANEL_SIZE_MAX.height;
	return {
		width: Math.round(clamp$1(size.width, PANEL_SIZE_MIN.width, maxW)),
		height: Math.round(clamp$1(size.height, PANEL_SIZE_MIN.height, maxH))
	};
}
const BALL_WINDOW_SIZE = BALL_SIZE + 2 * CHROME_INSET;
function panelWindowSize(panel) {
	return {
		width: panel.width + 2 * CHROME_INSET,
		height: panel.height + 2 * CHROME_INSET
	};
}
/** 默认面板对应的窗口尺寸。 */
const PANEL_WINDOW_SIZE = panelWindowSize(PANEL_SIZE_DEFAULT);
const BELOW_CENTER = .08;
const DOCK_OVERLAP = Math.round(BALL_SIZE / 5);
const DOCK_DRAG_OFF = Math.round(BALL_SIZE / 3);
const DOCK_TAB_WIDTH = 6;
const DOCK_GLOW = 8;
const DOCK_HOVER_MARGIN = 20;
const DOCK_HIT_WIDTH = DOCK_TAB_WIDTH + DOCK_GLOW + DOCK_HOVER_MARGIN;
const DOCK_HIT_HEIGHT = BALL_SIZE + 2 * DOCK_GLOW;
const DOCK_OFF_GAP = 2;
const DOCK_IN_PAD = 5;
const DOCK_SLIDE_OFF_MS = 250;
const DOCK_SLIDE_IN_MS = 300;
function clamp$1(value, min, max) {
	return Math.min(Math.max(value, min), Math.max(min, max));
}
function collapsedWindowBounds(ball) {
	return {
		x: ball.x - CHROME_INSET,
		y: ball.y - CHROME_INSET,
		width: BALL_WINDOW_SIZE,
		height: BALL_WINDOW_SIZE
	};
}
function isCollapsed(bounds) {
	return bounds.width <= BALL_WINDOW_SIZE && bounds.height <= BALL_WINDOW_SIZE;
}
function clampWindowOrigin(value, workOrigin, workSize, windowSize) {
	return clamp$1(value, workOrigin - CHROME_INSET, workOrigin + workSize - windowSize + CHROME_INSET);
}
/**
* Which outer display edge the ball already overlaps by about one fifth of its width.
* An edge that touches another display is a seam, not a place to dock.
*/
function dockSideForBallOrigin(ball, bounds, displays = []) {
	const leftOverlap = bounds.x - ball.x;
	const rightOverlap = ball.x + BALL_SIZE - (bounds.x + bounds.width);
	let side;
	if (leftOverlap >= DOCK_OVERLAP && leftOverlap >= rightOverlap) side = "left";
	else if (rightOverlap >= DOCK_OVERLAP) side = "right";
	if (side === void 0 || edgeTouchesDisplay(side, bounds, displays)) return void 0;
	return side;
}
function edgeTouchesDisplay(side, bounds, displays) {
	const edge = side === "left" ? bounds.x : bounds.x + bounds.width;
	for (const other of displays) {
		if (sameRect(other, bounds)) continue;
		const otherEdge = side === "left" ? other.x + other.width : other.x;
		if (Math.abs(otherEdge - edge) > 8) continue;
		const top = Math.max(bounds.y, other.y);
		if (Math.min(bounds.y + bounds.height, other.y + other.height) > top) return true;
	}
	return false;
}
function sameRect(left, right) {
	return left.x === right.x && left.y === right.y && left.width === right.width && left.height === right.height;
}
/** Hittable strip for a docked tab, flush with a display edge. */
function dockedTabBounds(side, ballY, bounds) {
	const y = clamp$1(Math.round(ballY - DOCK_GLOW), bounds.y, bounds.y + bounds.height - DOCK_HIT_HEIGHT);
	return {
		x: side === "left" ? bounds.x : bounds.x + bounds.width - DOCK_HIT_WIDTH,
		y,
		width: DOCK_HIT_WIDTH,
		height: DOCK_HIT_HEIGHT
	};
}
/** Panel growth that keeps the expanded overlay on the open side of the ball. */
function expandDirection(ball, workArea, panel = PANEL_SIZE_DEFAULT) {
	return {
		horizontal: ball.x + BALL_SIZE / 2 - workArea.x > workArea.width / 2 ? "left" : "right",
		vertical: ball.y - workArea.y < panel.height - BALL_SIZE ? "down" : "up"
	};
}
/** Ball top-left recovered from an expanded window and its growth direction. */
function ballOriginFromWindow(bounds, direction) {
	return {
		x: direction.horizontal === "left" ? bounds.x + bounds.width - CHROME_INSET - BALL_SIZE : bounds.x + CHROME_INSET,
		y: direction.vertical === "up" ? bounds.y + bounds.height - CHROME_INSET - BALL_SIZE : bounds.y + CHROME_INSET
	};
}
/** Keep a 72px ball fully inside a work area. */
function clampedBallOrigin(ball, workArea) {
	return {
		x: clamp$1(ball.x, workArea.x, workArea.x + workArea.width - BALL_SIZE),
		y: clamp$1(ball.y, workArea.y, workArea.y + workArea.height - BALL_SIZE)
	};
}
/** Collapsed origin on the work-area right edge, slightly below vertical center. */
function defaultFloatingBallOrigin(workArea) {
	const x = workArea.x + workArea.width - BALL_SIZE;
	const y = workArea.y + (workArea.height - BALL_SIZE) / 2 + workArea.height * BELOW_CENTER;
	return clampedBallOrigin({
		x: Math.round(x),
		y: Math.round(y)
	}, workArea);
}
function overlayBoundsFromBall(ball, direction, panel = PANEL_SIZE_DEFAULT) {
	const size = panelWindowSize(panel);
	return {
		x: direction.horizontal === "left" ? ball.x - (panel.width - BALL_SIZE) - CHROME_INSET : ball.x - CHROME_INSET,
		y: direction.vertical === "up" ? ball.y - (panel.height - BALL_SIZE) - CHROME_INSET : ball.y - CHROME_INSET,
		width: size.width,
		height: size.height
	};
}
function expandedOverlayBounds(ball, workArea, panel = PANEL_SIZE_DEFAULT) {
	const direction = expandDirection(ball, workArea, panel);
	const unclamped = overlayBoundsFromBall(ball, direction, panel);
	return {
		x: clampWindowOrigin(unclamped.x, workArea.x, workArea.width, unclamped.width),
		y: clampWindowOrigin(unclamped.y, workArea.y, workArea.height, unclamped.height),
		width: unclamped.width,
		height: unclamped.height,
		...direction
	};
}
function clampBallY(ballY, bounds) {
	return clamp$1(Math.round(ballY), bounds.y, bounds.y + bounds.height - BALL_SIZE);
}
function offScreenBallOrigin(side, ballY, bounds) {
	const y = clampBallY(ballY, bounds);
	return {
		x: side === "left" ? bounds.x - BALL_SIZE - DOCK_OFF_GAP : bounds.x + bounds.width + DOCK_OFF_GAP,
		y
	};
}
function insideBallOrigin(side, ballY, display) {
	return {
		x: side === "left" ? display.bounds.x + DOCK_IN_PAD : display.bounds.x + display.bounds.width - BALL_SIZE - DOCK_IN_PAD,
		y: clamp$1(Math.round(ballY), display.workArea.y, display.workArea.y + display.workArea.height - BALL_SIZE)
	};
}
function staysDocked(side, cursorX, bounds) {
	if (side === "right") return cursorX >= bounds.x + bounds.width - DOCK_DRAG_OFF;
	return cursorX <= bounds.x + DOCK_DRAG_OFF;
}
function easeInOutCubic(t) {
	return t < .5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
}
function easeOutCubic(t) {
	return 1 - (1 - t) ** 3;
}
function lerpRect(start, end, t) {
	return {
		x: Math.round(start.x + (end.x - start.x) * t),
		y: Math.round(start.y + (end.y - start.y) * t),
		width: Math.round(start.width + (end.width - start.width) * t),
		height: Math.round(start.height + (end.height - start.height) * t)
	};
}
/** Initial collapsed window, including the transparent chrome around the ball. */
function initialWindowBounds(workArea) {
	return collapsedWindowBounds(defaultFloatingBallOrigin(workArea));
}
/**
* Owns expand direction and dock state for one overlay window.
* Dock is committed on pointer-up, not while the ball is still moving.
*/
var FloatingPlacement = class {
	direction = {
		horizontal: "left",
		vertical: "up"
	};
	docked;
	anim = 0;
	/**
	* 面板内容区尺寸。用户在展开态拖窗口边缘会改它，之后所有 setBounds 都按它算。
	* ⚠️ 漏掉任何一处 setBounds 的 panel 参数，症状就是「拖大之后一移动球就弹回原尺寸」。
	*/
	panel = PANEL_SIZE_DEFAULT;
	/** 尺寸变化回调，交给 main.ts 持久化。 */
	onPanelSize;
	/**
	* 面板当前是否展开。由 `setExpanded` 维护。
	* 外部（右键菜单的穿透开关）要读它 —— 面板开着时窗口必须可点。
	* 初始为 false：窗口一起来就是球态。
	*/
	isExpanded = false;
	constructor(window, displayAt, displayBounds = () => [], options = {}) {
		this.window = window;
		this.displayAt = displayAt;
		this.displayBounds = displayBounds;
		if (options.panel) this.panel = clampPanelSize(options.panel);
		this.onPanelSize = options.onPanelSize;
	}
	/** 当前面板内容区尺寸。 */
	getPanelSize() {
		return { ...this.panel };
	}
	/**
	* 用户拖窗口边缘改了尺寸。只更新状态，不重新 setBounds ——
	* 让窗口就停在用户拖出来的位置，否则会跟Electron 的拖拽打架。
	*/
	setPanelSize(width, height, workArea) {
		const next = clampPanelSize({
			width,
			height
		}, workArea);
		this.panel = next;
		this.onPanelSize?.(next);
		return next;
	}
	/** Resize between the ball and the panel while keeping the ball origin fixed. */
	setExpanded(expanded) {
		const bounds = this.window.getBounds();
		const display = this.displayAt(center(bounds));
		// 记下当前展开态。外部（右键菜单的穿透开关）要据此判断
		// 「现在能不能恢复穿透」—— 面板开着的时候窗口必须可点。
		this.isExpanded = expanded === true;
		if (expanded) {
			const origin$1 = this.currentBallOrigin(display.workArea);
			this.docked = void 0;
			const next = expandedOverlayBounds(origin$1, display.workArea, this.panel);
			this.direction = {
				horizontal: next.horizontal,
				vertical: next.vertical
			};
			this.window.setBounds({
				x: next.x,
				y: next.y,
				width: next.width,
				height: next.height
			});
			return {
				expanded: true,
				...this.direction,
				docked: void 0
			};
		}
		if (this.docked) {
			this.applyTab(this.docked.side, this.docked.y, display.bounds);
			return {
				expanded: false,
				...this.direction,
				docked: this.docked.side
			};
		}
		const origin = clampedBallOrigin(this.currentBallOrigin(display.workArea), display.workArea);
		this.window.setBounds(collapsedWindowBounds(origin));
		return {
			expanded: false,
			...this.direction,
			docked: void 0
		};
	}
	/**
	* Move so the 72px ball origin follows `(x, y)`.
	* A collapsed ball may hang past a display edge. Dock is committed by {@link clamp}.
	*/
	move(x, y, canDock = true) {
		const origin = {
			x: Math.round(x),
			y: Math.round(y)
		};
		if (!isCollapsed(this.window.getBounds()) && this.docked === void 0) {
			const direction = this.direction;
			this.window.setBounds(overlayBoundsFromBall(origin, direction, this.panel));
			return { docked: void 0 };
		}
		if (!canDock) {
			this.docked = void 0;
			this.anim += 1;
			this.window.setBounds(collapsedWindowBounds(origin));
			return { docked: void 0 };
		}
		const display = this.displayAt(origin);
		if (this.docked && staysDocked(this.docked.side, origin.x, display.bounds)) {
			this.applyTab(this.docked.side, this.docked.y, display.bounds);
			return { docked: this.docked.side };
		}
		this.docked = void 0;
		this.anim += 1;
		this.window.setBounds(collapsedWindowBounds(origin));
		return { docked: void 0 };
	}
	/** Pull a free ball inside the work area, or dock it when it already overlaps a side edge. */
	async clamp(canDock = true) {
		const bounds = this.window.getBounds();
		const display = this.displayAt(center(bounds));
		if (this.docked) {
			this.applyTab(this.docked.side, this.docked.y, display.bounds);
			return { docked: this.docked.side };
		}
		if (isCollapsed(bounds)) {
			const origin = {
				x: bounds.x + CHROME_INSET,
				y: bounds.y + CHROME_INSET
			};
			if (canDock) {
				const side = dockSideForBallOrigin(origin, display.bounds, this.displayBounds());
				if (side) return this.snap(side, origin.y, display.bounds);
			}
			this.window.setBounds(collapsedWindowBounds(clampedBallOrigin(origin, display.workArea)));
			return { docked: void 0 };
		}
		this.setExpanded(true);
		return { docked: void 0 };
	}
	/** Slide the ball back on screen from a docked tab. */
	async unsnap() {
		if (!this.docked) return { docked: void 0 };
		const display = this.displayAt(center(this.window.getBounds()));
		const start = offScreenBallOrigin(this.docked.side, this.docked.y, display.bounds);
		const end = insideBallOrigin(this.docked.side, this.docked.y, display);
		this.docked = void 0;
		this.window.setBounds(collapsedWindowBounds(start));
		await this.animate(collapsedWindowBounds(end), DOCK_SLIDE_IN_MS, easeOutCubic);
		return { docked: void 0 };
	}
	currentBallOrigin(workArea) {
		const bounds = this.window.getBounds();
		if (this.docked) return insideBallOrigin(this.docked.side, this.docked.y, this.displayAt(center(bounds)));
		if (isCollapsed(bounds)) return {
			x: bounds.x + CHROME_INSET,
			y: bounds.y + CHROME_INSET
		};
		return ballOriginFromWindow(bounds, this.direction);
	}
	applyTab(side, ballY, bounds) {
		const y = clampBallY(ballY, bounds);
		this.docked = {
			side,
			y
		};
		this.anim += 1;
		this.window.setBounds(dockedTabBounds(side, y, bounds));
	}
	async snap(side, ballY, bounds) {
		const y = clampBallY(ballY, bounds);
		this.docked = {
			side,
			y
		};
		await this.animate(collapsedWindowBounds(offScreenBallOrigin(side, y, bounds)), DOCK_SLIDE_OFF_MS, easeInOutCubic);
		if (!this.docked || this.docked.side !== side) return { docked: this.docked?.side };
		this.window.setBounds(dockedTabBounds(side, y, bounds));
		return { docked: side };
	}
	animate(end, durationMs, ease) {
		const generation = ++this.anim;
		const start = this.window.getBounds();
		if (durationMs <= 0) {
			this.window.setBounds(end);
			return Promise.resolve();
		}
		return new Promise((resolve$1) => {
			const t0 = Date.now();
			const tick = () => {
				if (generation !== this.anim) {
					resolve$1();
					return;
				}
				const t = Math.min(1, (Date.now() - t0) / durationMs);
				this.window.setBounds(lerpRect(start, end, ease(t)));
				if (t < 1) {
					setTimeout(tick, 16);
					return;
				}
				resolve$1();
			};
			setTimeout(tick, 16);
		});
	}
};
function center(bounds) {
	return {
		x: bounds.x + bounds.width / 2,
		y: bounds.y + bounds.height / 2
	};
}

//#endregion
//#region src/menu-orb.ts
/** 预设头像。路径是相对 assets/ 的纯相对路径（正则只允许安全字符，防目录穿越）。 */
/**
 * 预设头像。
 *
 * ★ 开源版**自带 3 张自制球形态**（`avatars/orb-A.gif` 为默认、`avatars/orb-idle.gif`、`avatars/orb-pat.gif`）。
 *   想换成自己的：把 gif 直接丢进 `helper/assets/avatars/`，环菜单会自动出现
 *   （文件名用英文/数字/下划线/连字符 + `.gif`，**大小写都行**，见下面 PRESET_SRC）。
 */
const AVATAR_PRESETS = [
	{
		src: "avatars/orb-A.gif",
		name: "orb-A（默认）"
	}
];
const PRESET_SRC = /^[A-Za-z0-9][A-Za-z0-9_-]*(?:\/[A-Za-z0-9_-]+)*\.gif$/;
function isSafePresetSrc(src) {
	return PRESET_SRC.test(src);
}
function contextMenuTemplate(state, actions) {
	const zh = state.zh;
	const avatarItems = AVATAR_PRESETS.map((preset) => ({
		label: (zh ? preset.name : preset.name) + (state.avatar === preset.src ? "  ✓" : ""),
		type: "checkbox",
		checked: state.avatar === preset.src,
		click: () => {
			actions.setAvatar(preset.src);
		}
	}));
	return [
		{
			label: zh ? "更换显示样式（头像）" : "Change appearance (avatar)",
			submenu: avatarItems
		},
		{ type: "separator" },
		{
			label: zh ? `面板尺寸 ${state.panelSize.width}×${state.panelSize.height}（拖窗口边缘可改）` : `Panel ${state.panelSize.width}×${state.panelSize.height} (drag edges to resize)`,
			enabled: false
		},
		{
			label: zh ? "恢复默认尺寸" : "Reset panel size",
			click: () => {
				actions.resetPanelSize();
			}
		},
		{ type: "separator" },
		{
			label: zh ? "历史对话" : "Conversation history",
			click: () => {
				actions.openHistory();
			}
		},
		{
			// 2026-10-21：原来是「打开旧后端界面」（旧后端已剥离，点了只会弹「还没有旧后端地址」）。
			// 用户拍板改造成「她在 B 站看过什么」的抽屉 —— 与环菜单那一项同一个落点。
			label: zh ? "看过的视频" : "Videos she watched",
			click: () => {
				openBiliHistory();
			}
		},
		{ type: "separator" },
		{
			// ★ 2026-10-08 新增：球自己右键也有「隐藏」。
			//   托盘那项是「藏起来之后怎么回来」，这一项是「怎么藏起来」——
			//   两条路径都要有，否则用户想藏的时候得先找到托盘（反直觉）。
			label: zh ? "隐藏悬浮球" : "Hide floating ball",
			click: () => {
				actions.hideBall();
			}
		},
		{
			label: zh ? "停用悬浮球" : "Disable floating ball",
			click: () => {
				actions.disable();
			}
		}
	];
}

//#endregion
//#region src/cloak.ts
/**
* Milliseconds to wait after applying click-through before acking input begin,
* so WindowServer hit-testing has committed. Clicks posted earlier still land on
* the ball instead of the app underneath (the original's OVERLAY_GUARD_INPUT_APPLY_MS).
*/
const OVERLAY_GUARD_INPUT_APPLY_MS = 80;
/**
* Fire a cloak ack. Input begin waits {@link OVERLAY_GUARD_INPUT_APPLY_MS} after
* click-through was applied — the ack arriving is the host's signal that posted
* HID events may start. Every other transition acks immediately.
*/
function scheduleCloakAck(ack, mode, action) {
	if (mode !== "input" || action !== "begin") {
		ack();
		return;
	}
	setTimeout(ack, OVERLAY_GUARD_INPUT_APPLY_MS).unref();
}
/**
* Create the cloak. `clickThroughWindow` is the ball: it receives
* `setIgnoreMouseEvents`/`blur` on input-count crossings, chrome windows do not.
*/
function createAgentCloak(entries, clickThroughWindow) {
	const counts = {
		capture: 0,
		input: 0
	};
	let clickThrough = false;
	/**
	 * 外部（渲染层的右键菜单）临时改过穿透态而没走引用计数。
	 * 这时 `clickThrough` 记的是「我上次写的值」，不是「窗口现在的值」，
	 * 下次 sync 会因为 `next === clickThrough` 提前返回、**拒绝纠正**。
	 * 所以让调用方在外部改动后调这个，把缓存作废掉。
	 */
	let dirty = false;
	function sync() {
		const active = counts.capture > 0 || counts.input > 0;
		for (const entry of entries) {
			const window = entry.window();
			if (window === void 0 || window.isDestroyed()) continue;
			window.setContentProtection(active || entry.resting);
		}
		const next = counts.input > 0;
		if (!dirty && next === clickThrough) return;
		dirty = false;
		clickThrough = next;
		const ball = clickThroughWindow?.();
		if (ball === void 0 || ball.isDestroyed()) return;
		if (next) {
			ball.setIgnoreMouseEvents(true, { forward: false });
			ball.blur();
			return;
		}
		ball.setIgnoreMouseEvents(false);
	}
	return {
		begin(mode) {
			counts[mode] += 1;
			sync();
		},
		end(mode) {
			counts[mode] = Math.max(0, counts[mode] - 1);
			sync();
		},
		reset() {
			counts.capture = 0;
			counts.input = 0;
			sync();
		},
		/** 作废内部缓存，让下一次 sync 无条件重新应用。 */
		invalidate() {
			dirty = true;
		}
	};
}

//#endregion
//#region src/overlay-geometry.ts
/** Toolbar and observation-frame placement. No Electron import, so tests can run the same math. */
const SELECTION_TOOLBAR_SIZE = {
	width: 280,
	height: 46
};
const OBSERVATION_FRAME_STROKE_PX = 8;
const OBSERVATION_FRAME_GLOW_PX = 28;
const OBSERVATION_FRAME_OUTSET = OBSERVATION_FRAME_STROKE_PX + OBSERVATION_FRAME_GLOW_PX;
function clamp(value, min, max) {
	return Math.min(Math.max(value, min), Math.max(min, max));
}
/** Toolbar sits just below the mouse-up point and stays inside the work area. */
function selectionToolbarBounds(anchor, size = SELECTION_TOOLBAR_SIZE, workArea) {
	return {
		x: clamp(anchor.x, workArea.x, workArea.x + workArea.width - size.width),
		y: clamp(anchor.y + 8, workArea.y, workArea.y + workArea.height - size.height),
		width: size.width,
		height: size.height
	};
}
/**
* Grow the toolbar window for the language menu.
* The menu hangs below the bar when it fits, and above when it would leave the work area.
*/
function selectionToolbarMenuBounds(barOrigin, contentSize, workArea) {
	const width = Math.max(1, Math.round(contentSize.width));
	const height = Math.max(1, Math.round(contentSize.height));
	const x = clamp(barOrigin.x, workArea.x, workArea.x + workArea.width - width);
	if (barOrigin.y + height <= workArea.y + workArea.height || height <= SELECTION_TOOLBAR_SIZE.height) return {
		x,
		y: clamp(barOrigin.y, workArea.y, workArea.y + workArea.height - height),
		width,
		height
	};
	return {
		x,
		y: clamp(barOrigin.y + SELECTION_TOOLBAR_SIZE.height - height, workArea.y, workArea.y + workArea.height - height),
		width,
		height
	};
}
function intersectRects(area, clip) {
	const x = Math.max(area.x, clip.x);
	const y = Math.max(area.y, clip.y);
	const right = Math.min(area.x + area.width, clip.x + clip.width);
	const bottom = Math.min(area.y + area.height, clip.y + clip.height);
	const width = right - x;
	const height = bottom - y;
	if (width >= 1 && height >= 1) return {
		x,
		y,
		width,
		height
	};
	return {
		x: clamp(area.x, clip.x, clip.x + clip.width - 1),
		y: clamp(area.y, clip.y, clip.y + clip.height - 1),
		width: 1,
		height: 1
	};
}
function edgePadding(inset) {
	const leftover = Math.max(0, Math.round(inset));
	return {
		glow: Math.max(0, leftover - OBSERVATION_FRAME_STROKE_PX),
		stroke: OBSERVATION_FRAME_STROKE_PX
	};
}
/** Body glow and frame stroke that keep the inner hole on the observation rectangle. */
function observationFramePadding(region, bounds) {
	const left = edgePadding(region.x - bounds.x);
	const top = edgePadding(region.y - bounds.y);
	const right = edgePadding(bounds.x + bounds.width - (region.x + region.width));
	const bottom = edgePadding(bounds.y + bounds.height - (region.y + region.height));
	return {
		glow: {
			top: top.glow,
			right: right.glow,
			bottom: bottom.glow,
			left: left.glow
		},
		stroke: {
			top: top.stroke,
			right: right.stroke,
			bottom: bottom.stroke,
			left: left.stroke
		}
	};
}
/** Inflate the observation rectangle by the stroke and glow, then clip to the work area. */
function observationFramePlacement(region, workArea) {
	const bounds = intersectRects({
		x: Math.round(region.x - OBSERVATION_FRAME_OUTSET),
		y: Math.round(region.y - OBSERVATION_FRAME_OUTSET),
		width: Math.max(1, Math.round(region.width + OBSERVATION_FRAME_OUTSET * 2)),
		height: Math.max(1, Math.round(region.height + OBSERVATION_FRAME_OUTSET * 2))
	}, workArea);
	const padding = observationFramePadding(region, bounds);
	return {
		bounds,
		glow: padding.glow,
		stroke: padding.stroke
	};
}
function observationFrameCssScript(glow, stroke) {
	return `(() => { const root = document.documentElement.style; ${[
		["--glow-top", glow.top],
		["--glow-right", glow.right],
		["--glow-bottom", glow.bottom],
		["--glow-left", glow.left],
		["--stroke-top", stroke.top],
		["--stroke-right", stroke.right],
		["--stroke-bottom", stroke.bottom],
		["--stroke-left", stroke.left]
	].map(([name, value]) => `root.setProperty(${JSON.stringify(name)}, ${JSON.stringify(`${String(value)}px`)});`).join("")} })()`;
}
function pointInRect(point, bounds) {
	return point.x >= bounds.x && point.y >= bounds.y && point.x < bounds.x + bounds.width && point.y < bounds.y + bounds.height;
}

//#endregion
//#region src/overlays.ts
function denyWindowPermissions(created) {
	created.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => {
		callback(false);
	});
}
async function attachOverlays(deps) {
	const toolbar = openToolbar(fileURLToPath(new URL("../selection-preload.cjs", import.meta.url)));
	const frame = openFrame();
	let barOrigin = {
		x: 0,
		y: 0
	};
	let language = "zh";
	toolbar.webContents.on("did-finish-load", () => {
		toolbar.webContents.send("orb:selection-state", { language });
	});
	ipcMain.handle("orb:selection-size", (event, size) => {
		if (!fromToolbar(event, toolbar) || !isSize(size) || toolbar.isDestroyed()) return { menuAbove: false };
		const work = workAreaOf(barOrigin);
		const bounds = selectionToolbarMenuBounds(barOrigin, size, work);
		toolbar.setBounds(bounds);
		return { menuAbove: bounds.y < barOrigin.y };
	});
	ipcMain.on("orb:selection-action", (event, payload) => {
		if (!fromToolbar(event, toolbar)) return;
		if (typeof payload !== "object" || payload === null) return;
		const record = payload;
		if (record.action !== "search" && record.action !== "translate" && record.action !== "send" && record.action !== "language") return;
		deps.write({
			type: "selection-action",
			action: record.action,
			...record.language === "zh" || record.language === "en" ? { language: record.language } : {}
		});
	});
	await Promise.all([toolbar.loadFile(fileURLToPath(new URL("../assets/selection-toolbar.html", import.meta.url))), frame.loadFile(fileURLToPath(new URL("../assets/observation-frame.html", import.meta.url)))]);
	function ack(id) {
		if (typeof id === "string") deps.write({
			type: "overlay-ack",
			id
		});
	}
	function hideToolbar() {
		if (!toolbar.isDestroyed() && toolbar.isVisible()) toolbar.hide();
	}
	/**
	* The refcounted cloak from ./cloak.ts. Chrome windows rest captureable; each
	* `overlay-capture`/`overlay-input` interval lifts them out of screen captures,
	* and the observation frame keeps its Windows resting protection (it stays
	* visible around the observed region between captures).
	*/
	const cloak = createAgentCloak([
		{
			window: () => deps.ball(),
			resting: false
		},
		{
			window: () => toolbar,
			resting: false
		},
		{
			window: () => frame,
			resting: process.platform === "win32"
		}
	], () => deps.ball());
	function raiseChrome() {
		if (!frame.isDestroyed()) frame.setAlwaysOnTop(true, "floating");
		if (!toolbar.isDestroyed()) toolbar.setAlwaysOnTop(true, "screen-saver");
		const ball = deps.ball();
		if (ball && !ball.isDestroyed()) ball.setAlwaysOnTop(true, "screen-saver");
	}
	return {
		appearance(payload) {
			if (!toolbar.isDestroyed()) toolbar.webContents.send("orb:appearance", payload);
		},
		/**
		 * 作废 cloak 内部的穿透态缓存。
		 *
		 * 渲染层的右键菜单会**绕过引用计数**直接改球的鼠标穿透
		 * （见 `orb:menu-hold`）。cloak 自己记了一份「上次写的值」，
		 * 外部改过之后它会以为没变化而拒绝纠正 —— 表现为球再也点不动。
		 * 外部每改一次就要调这个。
		 *
		 * 注：独立版目前不下发 `overlay-input`，它的 input 计数恒为 0，
		 * 这个分支暂时是死的。留着是为了将来真接上时不用再踩一次 desync。
		 */
		invalidateClickThrough() {
			cloak.invalidate();
		},
		chromeWindows() {
			return [toolbar, frame];
		},
		deliver(message) {
			if (typeof message !== "object" || message === null) return false;
			const record = message;
			if (record.type === "selection") {
				if (typeof record.x !== "number" || typeof record.y !== "number") return true;
				language = record.language === "en" ? "en" : "zh";
				const work = workAreaOf({
					x: record.x,
					y: record.y
				});
				const bounds = selectionToolbarBounds({
					x: record.x,
					y: record.y
				}, SELECTION_TOOLBAR_SIZE, work);
				barOrigin = {
					x: bounds.x,
					y: bounds.y
				};
				if (!toolbar.isDestroyed()) {
					toolbar.setBounds(bounds);
					toolbar.showInactive();
					toolbar.webContents.send("orb:selection-state", { language });
					raiseChrome();
				}
				return true;
			}
			if (record.type === "selection-hide") {
				hideToolbar();
				return true;
			}
			if (record.type === "selection-pointer") {
				if (typeof record.x !== "number" || typeof record.y !== "number") return true;
				if (toolbar.isDestroyed() || !toolbar.isVisible() || !pointInRect({
					x: record.x,
					y: record.y
				}, toolbar.getBounds())) hideToolbar();
				return true;
			}
			if (record.type === "selection-language") {
				language = record.language === "en" ? "en" : "zh";
				if (!toolbar.isDestroyed()) toolbar.webContents.send("orb:selection-state", { language });
				return true;
			}
			if (record.type === "selection-attach") {
				const ball = deps.ball();
				if (ball && !ball.isDestroyed() && typeof record.text === "string") {
					ball.webContents.send("orb:attach", record.text);
					ball.showInactive();
				}
				hideToolbar();
				return true;
			}
			if (record.type === "overlay-capture") {
				if (record.active === false) cloak.end("capture");
				else cloak.begin("capture");
				ack(record.id);
				return true;
			}
			if (record.type === "overlay-input") {
				const begin = record.active === true;
				if (begin) hideToolbar();
				if (begin) cloak.begin("input");
				else cloak.end("input");
				scheduleCloakAck(() => ack(record.id), "input", begin ? "begin" : "end");
				return true;
			}
			if (record.type === "observation-frame") {
				showFrame(frame, record.bounds);
				raiseChrome();
				ack(record.id);
				return true;
			}
			return false;
		}
	};
}
function showFrame(frame, bounds) {
	if (frame.isDestroyed()) return;
	const region = readRect(bounds);
	if (region === void 0) {
		frame.hide();
		return;
	}
	const dip = toDip(region);
	const placement$1 = observationFramePlacement(dip, workAreaOf({
		x: dip.x + dip.width / 2,
		y: dip.y + dip.height / 2
	}));
	frame.setBounds(placement$1.bounds);
	frame.webContents.executeJavaScript(observationFrameCssScript(placement$1.glow, placement$1.stroke)).catch(() => {});
	frame.showInactive();
}
function toDip(region) {
	if (process.platform !== "win32") return region;
	const dip = screen.screenToDipRect(null, {
		x: Math.round(region.x),
		y: Math.round(region.y),
		width: Math.round(region.width),
		height: Math.round(region.height)
	});
	return {
		x: dip.x,
		y: dip.y,
		width: dip.width,
		height: dip.height
	};
}
function workAreaOf(point) {
	const area = screen.getDisplayNearestPoint({
		x: Math.round(point.x),
		y: Math.round(point.y)
	}).workArea;
	return {
		x: area.x,
		y: area.y,
		width: area.width,
		height: area.height
	};
}
function readRect(value) {
	if (typeof value !== "object" || value === null) return void 0;
	const record = value;
	if (typeof record.x !== "number" || typeof record.y !== "number" || typeof record.width !== "number" || typeof record.height !== "number") return;
	if (![
		record.x,
		record.y,
		record.width,
		record.height
	].every(Number.isFinite)) return void 0;
	if (record.width < 1 || record.height < 1) return void 0;
	return {
		x: record.x,
		y: record.y,
		width: record.width,
		height: record.height
	};
}
function fromToolbar(event, toolbar) {
	if (toolbar.isDestroyed()) return false;
	return event.sender === toolbar.webContents;
}
function isSize(value) {
	if (typeof value !== "object" || value === null) return false;
	const size = value;
	return typeof size.width === "number" && typeof size.height === "number" && Number.isFinite(size.width) && Number.isFinite(size.height) && size.width > 0 && size.height > 0 && size.width < 2e3 && size.height < 2e3;
}
function openToolbar(preload) {
	const created = new BrowserWindow({
		width: SELECTION_TOOLBAR_SIZE.width,
		height: SELECTION_TOOLBAR_SIZE.height,
		frame: false,
		transparent: true,
		alwaysOnTop: true,
		resizable: false,
		movable: false,
		minimizable: false,
		maximizable: false,
		fullscreenable: false,
		skipTaskbar: true,
		focusable: false,
		show: false,
		hasShadow: true,
		backgroundColor: "#00000000",
		roundedCorners: false,
		...process.platform === "darwin" ? { type: "panel" } : {},
		webPreferences: {
			preload,
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: true
		}
	});
	protect(created, "screen-saver");
	denyWindowPermissions(created);
	return created;
}
function openFrame() {
	const created = new BrowserWindow({
		width: 32,
		height: 32,
		frame: false,
		transparent: true,
		alwaysOnTop: true,
		resizable: false,
		movable: false,
		minimizable: false,
		maximizable: false,
		fullscreenable: false,
		skipTaskbar: true,
		focusable: false,
		show: false,
		hasShadow: false,
		backgroundColor: "#00000000",
		roundedCorners: false,
		...process.platform === "darwin" ? { type: "panel" } : {},
		webPreferences: {
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: true
		}
	});
	protect(created, "floating");
	if (process.platform === "win32") created.setContentProtection(true);
	denyWindowPermissions(created);
	created.setIgnoreMouseEvents(true, { forward: true });
	return created;
}
function protect(created, level) {
	created.setAlwaysOnTop(true, level);
	if (process.platform === "darwin") created.setVisibleOnAllWorkspaces(true, {
		visibleOnFullScreen: true,
		skipTransformProcessType: true
	});
	created.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
	created.webContents.on("will-navigate", (event) => {
		event.preventDefault();
	});
}

//#endregion
//#region src/window-state.ts
/** main.js 位于 <root>/helper/lib/，项目根要往上两层。 */
const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
function statePath() {
	const fromEnv = process.env.ORB_WINDOW_STATE;
	if (fromEnv) return isAbsolute(fromEnv) ? fromEnv : resolve(PROJECT_ROOT, fromEnv);
	return join(PROJECT_ROOT, "logs", "window-state.json");
}
function readWindowState() {
	const file = statePath();
	try {
		if (!existsSync(file)) return {};
		return JSON.parse(readFileSync(file, "utf8"));
	} catch {
		return {};
	}
}
function writeWindowState(state) {
	const file = statePath();
	try {
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, "utf8");
	} catch {}
}
/** 读出面板尺寸；没存过或非法就返回默认。夹到当前工作区内（换过显示器的情况）。 */
function loadPanelSize(workArea) {
	const saved = readWindowState().panel;
	if (!saved || typeof saved.width !== "number" || typeof saved.height !== "number") return { ...PANEL_SIZE_DEFAULT };
	return clampPanelSize(saved, workArea);
}
function savePanelSize(size) {
	writeWindowState({
		...readWindowState(),
		panel: {
			width: size.width,
			height: size.height
		}
	});
}
function loadStoredAvatar() {
	const saved = readWindowState().avatar;
	if (typeof saved !== "string" || saved === "") return void 0;
	// data: URL（自定义上传）原样返回
	if (saved.startsWith("data:")) return saved;
	// ★ 开源版剥离了原素材：存档里若还指向一个已不存在的 gif，回落到默认示例。
	//   不做这道检查的症状是「球变成一块黑」——src 404，控制台干净，很难查。
	if (!existsSync(avatarFilePath(saved))) {
		console.warn(`dsh-orb helper:存档头像 ${saved} 已不存在，回落默认`);
		return void 0;
	}
	return saved;
}
function saveStoredAvatar(src) {
	writeWindowState({
		...readWindowState(),
		avatar: src
	});
}
/**
* 面板毛玻璃透明度（右下角：环形菜单外侧那个圆环拖动改的就是它）。
* 为什么必须落盘：旧实现的 `--panel-opacity` 只在暗色主题的 CSS 块里声明过，
* 启动时又被一段写死的动画逻辑冲回 0.76 —— 用户拖完重启就丢。
* 范围与 helper/assets/ring-geometry.js 的 OPACITY_MIN / OPACITY_MAX 一致，
* 探针 probe/ring-geometry-test.mjs 会断言这两处数字相等。
*/
const PANEL_OPACITY_MIN = 0.2;
const PANEL_OPACITY_MAX = 1;
const PANEL_OPACITY_DEFAULT = 0.7;
function clampPanelOpacity(value) {
	const n = Number(value);
	if (!Number.isFinite(n)) return PANEL_OPACITY_DEFAULT;
	return Math.min(PANEL_OPACITY_MAX, Math.max(PANEL_OPACITY_MIN, n));
}
function loadStoredPanelOpacity() {
	const saved = readWindowState().panelOpacity;
	return saved === void 0 ? PANEL_OPACITY_DEFAULT : clampPanelOpacity(saved);
}
function saveStoredPanelOpacity(value) {
	const opacity = clampPanelOpacity(value);
	writeWindowState({
		...readWindowState(),
		panelOpacity: opacity
	});
	return opacity;
}
/**
* 主题偏好（用户 m02033「环形菜单里加一个主题菜单，黑白两色切换」）。
*
* `auto` = 跟随 host 传来的 appearance.theme（最终落到系统）；`light` / `dark`
* = 用户在主题页强制，host 之后再怎么推 appearance 都盖不掉它。
*
* ★ 为什么真源在主进程：真正决定明暗的是 Electron 的 `nativeTheme.themeSource`。
*   它一变，**所有窗口**的 prefers-color-scheme 一起变（球窗口、环菜单、
*   划词工具条），渲染层不必各存一份、也不会和 host 的推送打架。
*/
const THEME_MODES = ["auto", "light", "dark"];
const THEME_DEFAULT = "auto";
function clampThemeMode(value) {
	return THEME_MODES.includes(value) ? value : THEME_DEFAULT;
}
function loadStoredTheme() {
	return clampThemeMode(readWindowState().theme);
}
function saveStoredTheme(value) {
	const mode = clampThemeMode(value);
	writeWindowState({
		...readWindowState(),
		theme: mode
	});
	return mode;
}
/**
* 背景图三槽（对话页 chat / 历史页 history / 回忆页 recall）+ 每槽的适配方式
* 与蒙层浓度。**只存文件名**，图片本体在 helper/assets/backgrounds/ ——
* 不把用户机器的绝对路径写进状态文件，打包搬目录时也就不会失效。
*
* 适配方式三选一（都不形变）：cover=铺满裁切、contain=完整留边、auto=原始像素。
*/
const BG_SLOTS = ["chat", "history", "recall"];
const BG_FITS = ["cover", "contain", "auto"];
const BG_FIT_DEFAULT = "cover";
const BG_SCRIM_DEFAULT = 0.55;
const BG_SCRIM_MAX = 0.9;
/** 只有这个文件名形状能进 CSS（同 avatar 的 PRESET_SRC 纪律：不许父目录跳转）。 */
const BG_FILE$1 = /^bg-[a-z0-9][a-z0-9._-]*\.(?:png|jpe?g|webp|gif)$/i;
function clampBgFit(value) {
	return BG_FITS.includes(value) ? value : BG_FIT_DEFAULT;
}
function clampBgScrim(value) {
	const n = Number(value);
	if (!Number.isFinite(n)) return BG_SCRIM_DEFAULT;
	return Math.min(BG_SCRIM_MAX, Math.max(0, n));
}
function normalizeBgSlot(value) {
	const record = value && typeof value === "object" ? value : {};
	return {
		file: typeof record.file === "string" && BG_FILE$1.test(record.file) ? record.file : "",
		fit: clampBgFit(record.fit),
		scrim: clampBgScrim(record.scrim)
	};
}
function loadStoredBackgrounds() {
	const saved = readWindowState().backgrounds;
	const out = {};
	for (const slot of BG_SLOTS) out[slot] = normalizeBgSlot(saved?.[slot]);
	return out;
}
function saveStoredBackgrounds(slots) {
	const out = {};
	for (const slot of BG_SLOTS) out[slot] = normalizeBgSlot(slots?.[slot]);
	writeWindowState({
		...readWindowState(),
		backgrounds: out
	});
	return out;
}

//#endregion
//#region src/main.ts
const socketAddress = process.env.ORB_SOCKET ?? "";
const token = process.env.ORB_TOKEN ?? "";
const webPort = process.env.ORB_WEB_PORT ?? "";
const defaultSelection = {
	provider: "deepseek-official",
	model: "deepseek-flash",
	reasoningEffort: "max"
};
let chrome = {
	overlay: defaultSelection,
	background: defaultSelection,
	millifractionEnabled: false,
	openMain: false,
	catalog: { groups: [] }
};
let avatarToken = 0;
/**
* 独立版：旧后端的 http 地址，由 Host 在连上后通过 socket 推来。
* 右键菜单的「打开旧后端界面」用它 —— 这是独立版意义上的「主窗口」。
*/
let legacyHttp = "";
/** 当前头像预设的相对路径；空串表示用自带默认 GIF。 */
let currentAvatar = loadStoredAvatar() ?? "";
/**
* 托盘图标（★ 跟随球体显示）。
* 球体的头像是 `currentAvatar`（预设相对路径 / 空串=自带默认 / data URL 三种形态），
* 托盘把同一份东西转成 `nativeImage`。Windows 托盘不支持动画，GIF 只取第一帧 ——
* 视觉上仍是「同一个形象」，这就是「跟随」的合理边界。
*/
let tray;
/** 当前托盘的图标缓存（nativeImage），用于 isDestroyed 后重建与去重。 */
let trayImage = null;
/** 托盘图标的解码竞态令牌：快速连换头像时只认最后一次回传。 */
let trayIconToken = 0;
/**
* 球是否处于「已隐藏」态（用户 2026-10-08 新增）。
*
* 只用 `win.hide()` / `showInactive()` 实现 —— **不动 `win` 引用、不销毁窗口**：
* 销毁再建会连带丢掉渲染层状态（当前会话、已展开的抽屉、附件草稿），
* 而用户要的只是「它别挡着我」，不是「把它关了」。
*
* 副作用（刻意保留）：隐藏期间球仍占着屏幕一块矩形 —— 但窗口是透明的，
* 且隐藏时**一定**要 `setIgnoreMouseEvents(true)`，否则会留下一块「看不见但吃鼠标」的幽灵热区。
*/
let ballHidden = false;
/**
 * 隐藏悬浮球。幂等：已隐藏时再调什么都不做。
 *
 * ★★ 2026-10-08 第三轮真机反馈：**`hideBall()` 自己必须刷托盘**。
 *
 *   原来刷托盘这件事写在**托盘那一项的 click 回调里**（见 trayMenuTemplate），
 *   于是「从托盘点隐藏」文案是对的，而「从环菜单点隐藏」文案是错的 ——
 *   球已经没了，托盘却还写着「隐藏悬浮球」，用户点下去反而把球叫回来了。
 *
 *   根因是**把「状态变更」和「状态变更后的通知」拆在了两个地方**：
 *   谁改的状态谁不负责通知，只靠调用方自觉 —— 而调用方有四条路
 *   （托盘 / 原生右键 / 环菜单 / orb:ball-hide 信道），漏一条就出一个 bug。
 *
 *   修法：`hideBall()` / `showBall()` 自己收口，进来就把托盘文案刷对。
 *   调用方一律不用管 —— 这才是「唯一实现只有一处」该有的样子。
 *   （和「穿透必须单一所有者」是同一条教训：状态和它的副作用不许分家。）
 */
function hideBall() {
	if (ballHidden || !win || win.isDestroyed()) return;
	ballHidden = true;
	try {
		// ★ 先收穿透再隐藏，顺序不能反：hide() 之后窗口不再参与命中测试，
		//   但某些 Windows 版本在 hide 前会闪一帧，先关穿透更稳。
		win.setIgnoreMouseEvents(true);
	} catch {}
	win.hide();
	// 面板/环菜单都是独立窗口，球藏了它们就成了没锚点的浮层 —— 一起收掉。
	closeRingMenuWindow();
	// ★ 托盘文案跟着状态走（不依赖调用方记得刷）
	refreshTrayMenu();
	console.error("dsh-orb helper: 悬浮球已隐藏");
}
/** 显示悬浮球。幂等，且会把鼠标穿透恢复成球态该有的样子。 */
function showBall() {
	if (!ballHidden) return;
	ballHidden = false;
	if (!win || win.isDestroyed()) return;
	// showInactive：不抢焦点，避免用户正在别处打字时被球夺走键盘。
	win.showInactive();
	// ★ 恢复穿透这件事必须交给唯一所有者（见「穿透必须单一所有者」）：
	//   这里直接 setIgnoreMouseEvents(false) 会写字面值，而 cloak 内部
	//   那份「上次写的值」缓存还以为窗口是旧的 —— 之后它会以为没变化而拒绝纠正，
	//   表现成球再也点不动。invalidateClickThrough() 让 cloak 作废缓存后按真实状态重算。
	try {
		overlays?.invalidateClickThrough?.();
	} catch {}
	// 球态默认是穿透的（鼠标移上去才实体化），不在这里手写值，交给 cloak 决定。
	// ★ 同 hideBall：刷托盘也归自己管，别推给调用方。
	refreshTrayMenu();
	console.error("dsh-orb helper: 悬浮球已显示");
}
/** 重建托盘上下文菜单（文案随 ballHidden 翻转）。 */
function refreshTrayMenu() {
	if (!tray || tray.isDestroyed()) return;
	tray.setContextMenu(Menu.buildFromTemplate(trayMenuTemplate()));
}
let appearance = readAppearanceEnv();
process.title = "dsh-orb-helper";
if (!socketAddress || !token) {
	console.error("dsh-orb helper: socket environment is missing");
	process.exit(1);
}
if (process.platform === "darwin") app.setActivationPolicy?.("accessory");
let win;
let tccWait;
let overlays;
let placement;
let live;
let quitting = false;
let buffer = "";
app.on("before-quit", () => {
	quitting = true;
	live?.destroy();
	// 托盘图标在 Windows 上是真·系统资源：不显式销毁会残留一个点不动的死图标。
	if (tray && !tray.isDestroyed()) tray.destroy();
	tray = void 0;
});
app.on("window-all-closed", () => {
	app.quit();
});
app.whenReady().then(async () => {
	if (process.platform === "darwin") app.dock?.hide();
	// 托盘先建：球窗口 skipTaskbar，托盘是它唯一的常驻入口，越早出现越好。
	createTray();
	win = openWindow();
	try {
		overlays = await attachOverlays({
			ball: () => win,
			write
		});
	} catch (error) {
		console.error(`dsh-orb helper: overlays did not open: ${error instanceof Error ? error.message : String(error)}`);
	}
	placement = new FloatingPlacement(win, (point) => {
		const display = screen.getDisplayNearestPoint({
			x: Math.round(point.x),
			y: Math.round(point.y)
		});
		return {
			bounds: display.bounds,
			workArea: display.workArea
		};
	}, () => screen.getAllDisplays().map((display) => display.bounds), {
		panel: loadPanelSize(screen.getPrimaryDisplay().workArea),
		onPanelSize: (size) => savePanelSize(size)
	});
	win.webContents.on("did-finish-load", () => {
		if (win && !win.isVisible()) win.showInactive();
		pushAppearance();
		if (currentAvatar !== "") win?.webContents.send("orb:avatar", currentAvatar);
		// 球重载后托盘也校准一次：托盘是独立生命周期，不跟着球窗口重建。
		refreshTrayIcon(currentAvatar);
		win?.webContents.send("orb:panel-opacity", loadStoredPanelOpacity());
		// 主题页与三张背景图也一并在装载完成时推下去（渲染层不自己读盘）。
		win?.webContents.send("orb:theme", themeSnapshot());
		win?.webContents.send("orb:backgrounds", backgroundsSnapshot());
	});
	nativeTheme.on("updated", () => {
		pushAppearance();
	});
	applyAppearance();
	await win.loadFile(fileURLToPath(new URL("../assets/floating.html", import.meta.url)));
	// 预热环菜单窗口：首次右键才 new BrowserWindow + loadFile 要 ~0.5s 以上，
	// 用户看到的是「第一次点没反应、再点一次才出来」——正是 m00827 §1 报的观感。
	// 预建之后每次打开只剩 setBounds + showInactive，肉眼即时。
	openRingMenuWindow();
	connect(0);
});
/**
* 独立版新增：把面板尺寸写回 placement。
*
* 为什么需要这个显式通道（真机上并不需要）：
* Electron 的 `resized` 事件**只在真实用户拖拽窗口边缘时触发**，
* 程序自己调 setBounds 不触发。所以在没有显示器的环境里，
* 无法验证「尺寸回写 + 落盘」这条链路。留一个 ipc 通道让测试能主动驱动它。
*/
ipcMain.handle("orb:resize", (event, width, height) => {
	if (!fromBall(event) || !placement || !win) return null;
	const b = win.getBounds();
	if (isCollapsedBounds(b)) return null;
	const workArea = screen.getDisplayMatching(b).workArea;
	const next = placement.setPanelSize(Number(width), Number(height), workArea);
	// ★ 这里**必须**自己 setBounds。
	//
	// `placement.setPanelSize()` 故意只改状态、不动窗口 ——
	// 那是给系统级 `resized` 事件准备的：那种路径下窗口已经被 Electron
	// 拖过了，再 setBounds 会跟用户抢窗口。
	// 但渲染层自绘手柄（resize-handles.js）走的是另一条路：
	// 窗口从来没被动过，不 setBounds 就等于「只记账、不改窗」——
	// 松手后面板尺寸写进了状态和配置文件，**屏幕上却一点没变**。
	//
	// 2026-10-07 实测：`frame:false` + `transparent:true` 的窗口在 Windows 上
	// 没有系统 resize 热区，手柄是用户唯一能拖的地方，这条链路不通
	// 就等于整个 P0-5 功能不存在。
	//
	// 走 setExpanded(true) 而不是直接 setBounds：它按球原点 + 展开方向
	// 重算窗口位置，保证「面板变大时球不会跑偏」。
	//
	// ★ 它同时**重算了展开方向**：面板变大后可能从球的左边翻到右边
	// （`expandedOverlayBounds` 按可用空间选边）。返回它，球侧才知道
	// resize 手柄该换到哪几条边（`freeEdges()`）。只回尺寸的话，
	// 手柄会一直按旧方向显示 —— 面板已经长到球右边了，手柄还在左边。
	const state = placement.setExpanded(true);
	console.error(
		`[orb] orb:resize → 面板尺寸 = ${next.width}×${next.height}，窗口已 setBounds，方向 = ${state.horizontal}/${state.vertical}`
	);
	// 尺寸和方向合成一个对象返回：调用方要的是「改完之后面板长什么样」。
	return { ...next, ...state };
});
/**
 * 归一化 `orb:prompt` 的载荷（P2-4）。
 *
 * 收两种形状：
 *   - 字符串：`send('你好')` —— 老渲染层 / 探针 / 手工脚本
 *   - 对象  ：`{ type:'prompt', text, attachments? }` —— 当前渲染层
 *
 * 返回 `{type:'prompt', text, attachments?}`，非法则返回 null（**静默丢弃**是
 * 这里的 deliberate choice：这是 IPC 边界，写一行日志比把畸形数据透传给主进程安全）。
 *
 * ⚠️ 附件**只透传 name/mimeType/data 三个字段** —— 但这不是白名单式的「静默丢字段」，
 *    因为超限的那一条会**整条被丢**并打日志，而不是悄悄削掉字段让 host 收到半个附件。
 *    上一版 `conversationAction` 白名单的教训是：丢了字段还不报，用户看到的是
 *    「设了密码但没生效」。所以这里的守则是：**要么完整通过，要么整条拒绝**。
 */
const MAX_ATTACHMENTS = 6;
/** 单张图的 base64 上限。压缩目标 512KB，base64 膨胀 ~33% → 约 683KB；
 *  留一倍余量到 4MB，防止渲染层压缩失败时传原图把 IPC 撑爆。 */
const MAX_ATTACHMENT_B64 = 4 * 1024 * 1024;

function normalizePrompt(payload) {
	if (typeof payload === "string") {
		return payload.trim() === "" ? null : {
			type: "prompt",
			text: payload
		};
	}
	if (typeof payload !== "object" || payload === null) return null;
	if (typeof payload.text !== "string") return null;
	const out = {
		type: "prompt",
		text: payload.text
	};
	const list = payload.attachments;
	if (!Array.isArray(list) || list.length === 0) return out;
	if (list.length > MAX_ATTACHMENTS) {
		console.error(`[orb] 附件超过 ${MAX_ATTACHMENTS} 张，已忽略整批附件`);
		return out;
	}
	const kept = [];
	for (const raw of list) {
		if (typeof raw !== "object" || raw === null) continue;
		const data = typeof raw.data === "string" ? raw.data : "";
		const mimeType = typeof raw.mimeType === "string" ? raw.mimeType : "";
		if (data === "" || !mimeType.startsWith("image/")) continue;
		if (data.length > MAX_ATTACHMENT_B64) {
			console.error(`[orb] 附件过大（${data.length} base64 字符），已跳过：${mimeType}`);
			continue;
		}
		kept.push({
			name: typeof raw.name === "string" ? raw.name.slice(0, 200) : "image",
			mimeType,
			data
		});
	}
	if (kept.length > 0) out.attachments = kept;
	return out;
}

ipcMain.handle("orb:expand", (event, expanded) => {
	if (!fromBall(event) || !placement || typeof expanded !== "boolean") return {
		expanded: false,
		horizontal: "left",
		vertical: "up",
		docked: void 0
	};
	try {
		win?.setResizable(expanded);
	} catch {}
	const next = placement.setExpanded(expanded);
	// 展开态收尾：面板开着就一定不能是穿透态。
	// 平时这个状态由 `orb:menu-hold` 的开/关配对维持，但菜单开着的时候
	// 用户点条目会触发展开 —— 这条路径不经过菜单的 close()，
	// 所以在这里补一次收口，避免留下「亮着但点不动」的面板。
	if (expanded === true && !menuHolding) {
		try {
			win?.setIgnoreMouseEvents(false);
		} catch {}
	}
	// 面板一展开就收掉环形菜单：桌面端两个「球周围的东西」同时开着会互相打架
	// （环菜单窗口是 screen-saver 级 alwaysOnTop，会盖住面板左上角）。
	if (expanded === true) closeRingMenuWindow();
	return next;
});
ipcMain.handle("orb:move", (event, request$1) => {
	if (!fromBall(event) || !placement || !isMove(request$1)) return { docked: void 0 };
	return placement.move(request$1.x, request$1.y, request$1.canDock);
});
ipcMain.handle("orb:clamp", async (event, canDock) => {
	if (!fromBall(event) || !placement) return { docked: void 0 };
	return placement.clamp(canDock !== false);
});
ipcMain.handle("orb:unsnap", async (event) => {
	if (!fromBall(event) || !placement) return { docked: void 0 };
	return placement.unsnap();
});
ipcMain.on("orb:prompt", (event, payload) => {
	if (!fromBall(event)) return;
	// 兼容两种载荷：老版字符串 `send(text)`，与 P2-4 起的对象
	// `{ type:'prompt', text, attachments? }`。渲染层已统一发对象，
	// 但探针与旧脚本仍会传裸字符串，这里两条都收。
	const record = normalizePrompt(payload);
	if (record === null) return;
	write(record);
});
ipcMain.on("orb:question-answer", (event, payload) => {
	if (!fromBall(event)) return;
	if (typeof payload !== "object" || payload === null) return;
	const record = payload;
	write({
		type: "question-answer",
		id: record.id,
		answers: record.answers
	});
});
ipcMain.on("orb:question-cancel", (event, id) => {
	if (!fromBall(event)) return;
	write({
		type: "question-cancel",
		id
	});
});
ipcMain.on("orb:history", (event) => {
	if (!fromBall(event)) return;
	write({ type: "history" });
});
/**
 * 记忆中心上行（P0-7）。
 *
 * 一条通道带一个 `{action, ...}`，而不是六条 IPC ——
 * host 侧本来就按 `type` 分发（见 `src/main.mjs` 的 impression-* case），
 * 这里直接把 action 映射成对应的 `type`，省掉六个几乎一样的 handler。
 *
 * ⚠️ 载荷必须**逐字段白名单重建**，不能把渲染层传来的对象整个 write出去：
 * 渲染层是「可被模型内容影响」的那一侧，转发任意字段等于给了一条
 * 「让球往 host 塞任意 type」的路。白名单外的字段直接丢掉。
 */
ipcMain.on("orb:impression", (event, message) => {
	if (!fromBall(event)) return;
	const action = typeof message?.action === "string" ? message.action : "";
	if (action === "get") {
		write({ type: "impression-get" });
		return;
	}
	if (action === "refresh") {
		write({ type: "impression-refresh" });
		return;
	}
	if (action === "history-get") {
		write({ type: "impression-history-get" });
		return;
	}
	if (action === "at-get") {
		const sha = typeof message?.sha === "string" ? message.sha : "";
		if (sha === "") return;
		write({ type: "impression-at-get", sha });
		return;
	}
	if (action === "schedule") {
		const hours = Number(message?.everyHours);
		// 只接受三档（24/ 168 / 0=关）。host 侧 `normalizeEveryHours` 也会夹，
		// 但渲染层传来的数字不该直接落进配置。
		if (hours !== 0 && hours !== 24 && hours !== 168) return;
		write({ type: "impression-schedule", everyHours: hours });
		return;
	}
	if (action === "archive-now") {
		write({ type: "memory:archive-now" });
	}
});
ipcMain.on("orb:open", (event, sessionId) => {
	if (!fromBall(event)) return;
	if (typeof sessionId === "string") write({
		type: "open",
		sessionId
	});
});
ipcMain.on("orb:new", (event) => {
	if (!fromBall(event)) return;
	write({ type: "new" });
});
ipcMain.on("orb:permission", (event, preset) => {
	if (!fromBall(event)) return;
	if (typeof preset === "string") write({
		type: "permission",
		preset
	});
});
ipcMain.on("orb:stop", (event) => {
	if (!fromBall(event)) return;
	write({ type: "stop" });
});
ipcMain.on("orb:copy", (event, text) => {
	if (!fromBall(event)) return;
	if (typeof text !== "string" || text.length > 1e6) return;
	clipboard.writeText(text);
});
ipcMain.handle("orb:menu", async (event) => {
	if (!fromBall(event) || !win) return;
	write({ type: "menu" });
	await showMenu(win);
});
/**
 * 渲染层 DOM 右键菜单要用：球态下窗口是穿透的（`setIgnoreMouseEvents(true,
 * { forward: true })`），右键事件到不了渲染层 —— 表现为「右键球没反应，菜单不弹」。
 * 所以弹菜单前先关穿透，菜单关掉后再恢复。
 *
 * ⚠️ 球和面板**是同一个 BrowserWindow**（`attachOverlays` 的 `deps.ball`
 * 就是 `() => win`），所以这里直接用 `win`，不要去碰 `openFrame()` 建的
 * 观察框窗口（那个是 `focusable: false`，跟右键无关）。
 *
 * ★★ 2026-10-07 重写。上一版是「收到关穿透请求 → 延时 220ms 无条件恢复」，
 * 那个设计有两个会把球弄成死的缺陷：
 *
 *   1. **无条件恢复**。如果这期间面板已经展开了（用户点完菜单项、或者
 *      面板本来就是开着的），恢复穿透等于**把一个可见可点的面板变成幽灵**，
 *      鼠标穿透它、点它没反应 —— 看起来就是「球卡死了」。
 *   2. **窗口穿透没有单一所有者**。`createAgentCloak`（见上方 src/cloak.ts）
 *      也写同一个窗口的 `setIgnoreMouseEvents`，而它内部记了一份
 *      「上次写的值」，外部绕过它改过之后它会以为没变化而**拒绝纠正**。
 *      （实测：独立版从不下发 `overlay-input`，所以它的 input 引用计数恒为 0，
 *      这个分支目前是死的 —— 但死分支不代表可以不管，payload 一旦接上
 *      就会立刻变成真bug，所以留了 `invalidateClickThrough()` 这道保险。）
 *
 * 现在改成**显式接管**：渲染层在 `open()` / `close()` 里如实上报，
 * 主进程只在「菜单确实开着」期间关穿透，菜单一关立刻恢复。
 * 加一个上限超时兜底，防止渲染层异常时永远不放（那时窗口会保持可点，
 * 比保持穿透安全 —— 穿透的破坏性远大于不穿透）。
 */
const MENU_HOLD_MAX_MS = 60_000;
let menuHoldTimer;
let menuHolding = false;

/**
 * 保证球窗口**始终可点**（不再有「球态穿透」这个状态）。
 *
 * ★★ 2026-10-07 夜重写。旧实现在球态把窗口设成
 *   `setIgnoreMouseEvents(true, { forward: true })`，也就是说**球态下球窗口是穿透的**：
 *   鼠标事件（含右键的 contextmenu）根本到不了渲染层，只能靠 `forward: true`
 *   送进来的 mousemove 触发 `pointerenter → setExpanded(true)`，
 *   再由 `orb:expand` 里 `expanded === true && !menuHolding` 那一支把穿透关掉。
 *   净效果是「必须先悬停点亮、再点击才有效」，直接点就是没反应 ——
 *   用户实测「右键球要按好几次菜单才出来」的机制就在这里。
 *
 *   现在球是**左键开面板、右键开环菜单**的唯一入口，穿透态没有任何价值；
 *   而且 `createAgentCloak` 那条穿透分支在独立版是死的
 *   （从不下发 `overlay-input`，input 引用计数恒 0）。所以这里彻底不写穿透。
 */
function restoreBallClickThrough() {
	if (!win || win.isDestroyed()) return;
	try {
		win.setIgnoreMouseEvents(false);
	} catch {}
}

ipcMain.on("orb:menu-hold", (event, holding) => {
	if (!fromBall(event) || !win || win.isDestroyed()) return;
	if (menuHoldTimer) {
		clearTimeout(menuHoldTimer);
		menuHoldTimer = void 0;
	}
	// 每次外部改动都要让 cloak 忘掉它记的旧值，否则它会拒绝纠正
	overlays?.invalidateClickThrough?.();
	if (holding === true) {
		menuHolding = true;
		try {
			win.setIgnoreMouseEvents(false);
		} catch {}
		// 兜底：渲染层若没回调（崩了/断连），最多保持 60s 就放回穿透态。
		menuHoldTimer = setTimeout(() => {
			menuHoldTimer = void 0;
			menuHolding = false;
			overlays?.invalidateClickThrough?.();
			restoreBallClickThrough();
		}, MENU_HOLD_MAX_MS);
		if (typeof menuHoldTimer.unref === "function") menuHoldTimer.unref();
		return;
	}
	if (menuHolding === false) return;
	menuHolding = false;
	restoreBallClickThrough();
});
ipcMain.on("orb:edit-menu", (event) => {
	if (!fromBall(event) || !win || win.isDestroyed()) return;
	//可编辑区的原生编辑菜单。Electron 默认不弹浏览器右键菜单，
	// 渲染层「让给浏览器」等于右键没反应 —— 这里用编辑角色补上。
	// ⚠️ 只在**展开态**用：球态窗口是穿透的，弹了也没地方点。
	if (placement?.isExpanded !== true) return;
	Menu.buildFromTemplate([
		{ role: "undo", label: "撤销" },
		{ role: "redo", label: "重做" },
		{ type: "separator" },
		{ role: "cut", label: "剪切" },
		{ role: "copy", label: "复制" },
		{ role: "paste", label: "粘贴" },
		{ role: "selectAll", label: "全选" }
	]).popup({ window: win });
});
ipcMain.on("orb:open-external", (event, url) => {
	if (!fromBall(event)) return;
	if (typeof url !== "string" || !/^https?:\/\//i.test(url) || url.length > 4e3) return;
	shell.openExternal(url);
});
ipcMain.handle("orb:avatars", (event) => {
	if (!fromBall(event)) return [];
	// 清单直接给渲染层，**不在渲染层再复制一份** —— 加预设只改这一处。
	// 只暴露 src 与 name，不把整个预设对象（含内部字段）送出去。
	const list = AVATAR_PRESETS.map((preset) => ({
		src: preset.src,
		name: preset.name
	}));
	// ★ 用户自备素材：丢进 helper/assets/avatars/ 就会自动出现在这里 ——
	//   「自行导入 gif」不需要改任何配置。文件名用 PRESET_SRC 同款规则过滤，
	//   目录不存在（开源版默认就是空的）也算正常。
	try {
		const dir = join(PROJECT_ROOT, "helper", "assets", "avatars");
		for (const file of readdirSync(dir)) {
			if (!/^[A-Za-z0-9][A-Za-z0-9_-]*\.gif$/.test(file)) continue;
			const src = `avatars/${file}`;
			if (list.some((item) => item.src === src)) continue;
			list.push({ src, name: file.slice(0, -4) });
		}
	} catch {
		// 没有这个目录 = 没有自备素材，不是错误
	}
	return list;
});
ipcMain.on("orb:avatar-set", (event, src) => {
	if (!fromBall(event)) return;
	// applyAvatar 内部有 isSafePresetSrc 校验，非法路径会被拒并打日志
	applyAvatar(src);
});
/**
 * 隐藏悬浮球（球窗口发起，2026-10-08）。
 *
 * 两条来路都汇到这里：
 *   1. 球窗口渲染层（比如将来某处想加个「隐藏」按钮）→ `orb:ball-hide`；
 *   2. 环菜单的 `ball-hide` 项 → 主进程直接调 `hideBall()`（见 orb:ring-action）。
 * 托盘与原生右键那两项也在主进程里直接调。**唯一的实现只有 `hideBall()` 一处**，
 * 不给任何调用方留「自己 hide 一下」的余地 —— 那会绕过穿透收口和环菜单清理。
 */
ipcMain.on("orb:ball-hide", (event) => {
	if (!fromBall(event)) return;
	hideBall();
});
ipcMain.on("orb:open-legacy-web", (event) => {
	if (!fromBall(event)) return;
	// ★ 这条信道是**渲染层已经判过地址**才发的（见 shell.js 的 openLegacyWeb：
	//   拿不到地址它会先开「API 配置」抽屉，根本走不到这里）。
	//   所以正常情况一定能开成；真开不成（地址在这一瞬被清掉）就弹框，
	//   不要在这里再静默一次 —— 「静默丢弃族」已经够多了。
	if (!openLegacyWeb()) notifyNoLegacyAddress();
});
/**
 * 独立版新增：对话级操作（重命名 / 删除 / 锁定）从渲染层转发给 host。
 *
 * 渲染层只负责「用户点了哪一项」，能不能做由 host 说了算 ——
 * 这条通道是单向的（球 → host），回包走 host → 球的 `conversation-action-result`。
 *
 * ⚠️ host 侧 `history-rename` / `history-delete` **尚未实现**（见待办事项 P0-4），
 * 现在发过去只会看到 host 忽略。锁定走的是加密方案（`对话加密_落地方案.md`）。
 */
ipcMain.on("orb:conversation-action", (event, message) => {
	if (!fromBall(event)) return;
	if (typeof message !== "object" || message === null) return;
	const action = typeof message.action === "string" ? message.action : "";
	if (
		action !== "history.rename"
		&& action !== "history.delete"
		&& action !== "history.lock"
		&& action !== "history.set-password"
		&& action !== "history.export"
	) return;
	const payload = typeof message.payload === "object" && message.payload !== null ? message.payload : {};
	const sessionId = typeof payload.sessionId === "string" ? payload.sessionId : "";
	if (sessionId === "") return;
	write({
		type: "conversation-action",
		action,
		sessionId,
		payload
	});
});
/**
 * 对话隐私锁：解锁尝试 / 手动上锁（球 → host）。
 *
 * 走**独立的 IPC 通道**而不是复用 `orb:conversation-action`，原因有二：
 *   1. `unlock` 是**全局**操作（软锁下没有 sessionId），而 conversation-action
 *      的形状强制要求 sessionId —— 硬塞会变成「软锁解锁必须编一个会话 id」。
 *   2. 语义不同：conversation-action 是「对某条会话做动作」，
 *      这条是「我（这个人）在向锁证明身份」。
 *
 * ⚠️ `input` 是用户敲的暗号**或密码原文**。它只走内存、随 IPC 交给 host 比对，
 *    绝不能写日志、不能进任何持久化 —— 方案 §6 的硬约束。
 */
ipcMain.on("orb:lock-action", (event, message) => {
	if (!fromBall(event)) return;
	if (typeof message !== "object" || message === null) return;
	const kind = typeof message.kind === "string" ? message.kind : "";
	if (kind === "lock-now") {
		write({ type: "lock-now" });
		return;
	}
	if (kind !== "unlock") return;
	write({
		type: "unlock",
		input: typeof message.input === "string" ? message.input : "",
		convId: typeof message.convId === "string" ? message.convId : ""
	});
});
/**
 * 历史回放里的「图片 ×N」占位被点开（P2-4 补）：球 → host 按需取原图。
 *
 * ⚠️ 上行**只带块 key**，不带文件路径。host 自己按 key 里的
 *    `<convId>|u:ui-msg-N` 去那一条会话的 messages.jsonl 里找 ——
 *    渲染层拿不到「任意读文件」的权力，这条通道也就没法被拼 path 打穿。
 */
ipcMain.on("orb:image-request", (event, key) => {
	if (!fromBall(event)) return;
	if (typeof key !== "string" || key === "") return;
	write({ type: "image-request", key });
});
ipcMain.handle("orb:tcc-status", (event) => {
	if (!fromBall(event)) return tccUnavailable();
	return askTcc({ type: "tcc" });
});
ipcMain.handle("orb:tcc-open", (event, right) => {
	if (!fromBall(event)) return tccUnavailable();
	if (right !== "screen" && right !== "accessibility") return tccUnavailable();
	return askTcc({
		type: "tcc-open",
		right
	});
});
function openWindow() {
	const bounds = initialWindowBounds(screen.getPrimaryDisplay().workArea);
	const created = new BrowserWindow({
		title: "dsh-orb",
		x: bounds.x,
		y: bounds.y,
		width: bounds.width,
		height: bounds.height,
		frame: false,
		transparent: true,
		alwaysOnTop: true,
		resizable: false,
		minWidth: PANEL_SIZE_MIN.width + 2 * CHROME_INSET,
		minHeight: PANEL_SIZE_MIN.height + 2 * CHROME_INSET,
		movable: true,
		minimizable: false,
		maximizable: false,
		fullscreenable: false,
		skipTaskbar: true,
		hasShadow: false,
		focusable: true,
		show: false,
		backgroundColor: "#00000000",
		roundedCorners: false,
		...process.platform === "darwin" ? { type: "panel" } : {},
		webPreferences: {
			preload: fileURLToPath(new URL("../preload.cjs", import.meta.url)),
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: true
		}
	});
	denyWindowPermissions(created);
	created.setAlwaysOnTop(true, "screen-saver");
	if (process.platform === "darwin") created.setVisibleOnAllWorkspaces(true, {
		visibleOnFullScreen: true,
		skipTransformProcessType: true
	});
	created.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
	created.webContents.on("context-menu", (event, params) => {
		if (params?.isEditable || params?.hasSelection) return;
		event.preventDefault();
		write({ type: "menu" });
		setTimeout(() => {
			showMenu(created);
		}, 30);
	});
	created.webContents.on("will-navigate", (event) => {
		event.preventDefault();
	});
	created.on("closed", () => {
		if (!quitting) app.quit();
	});
	created.on("resized", () => {
		const b = created.getBounds();
		console.error(`[window-probe] resized 触发 → ${b.width}×${b.height}`);
		if (!placement) return;
		if (isCollapsedBounds(b)) return;
		const workArea = screen.getDisplayMatching(b).workArea;
		const next = placement.setPanelSize(b.width - 2 * CHROME_INSET, b.height - 2 * CHROME_INSET, workArea);
		console.error(`[window-probe] placement 面板尺寸 = ${next.width}×${next.height}`);
	});
	created.on("will-resize", (event, bounds$1) => {
		if (!placement || isCollapsedBounds(bounds$1)) return;
		event.preventDefault();
		const workArea = screen.getDisplayMatching(bounds$1).workArea;
		const panelW = bounds$1.width - 2 * CHROME_INSET;
		const panelH = bounds$1.height - 2 * CHROME_INSET;
		const next = placement.setPanelSize(panelW, panelH, workArea);
		created.setBounds({
			...bounds$1,
			width: next.width + 2 * CHROME_INSET,
			height: next.height + 2 * CHROME_INSET
		});
	});
	created.once("ready-to-show", () => {
		created.showInactive();
		const shown = created.getBounds();
		console.error(`dsh-orb helper: ball ${shown.x},${shown.y} ${shown.width}x${shown.height}`);
	});
	return created;
}
/** 球态窗口（约 96×96）不是面板，别把它的尺寸当成用户拖出来的面板尺寸。 */
function isCollapsedBounds(bounds) {
	return bounds.width <= BALL_WINDOW_SIZE && bounds.height <= BALL_WINDOW_SIZE;
}
function connect(attempt) {
	if (quitting) return;
	const colon = socketAddress.lastIndexOf(":");
	const socket = createConnection({
		host: socketAddress.slice(0, colon),
		port: Number(socketAddress.slice(colon + 1))
	});
	socket.setEncoding("utf8");
	let opened = false;
	socket.on("connect", () => {
		opened = true;
		live = socket;
		buffer = "";
		socket.write(`${JSON.stringify({
			type: "hello",
			token,
			pid: process.pid
		})}\n`);
		const ids = chromeWindowIds();
		if (ids.length > 0) write({
			type: "chrome-windows",
			ids
		});
	});
	socket.on("data", (chunk) => {
		buffer += chunk;
		const parts = buffer.split("\n");
		buffer = parts.pop() ?? "";
		for (const part of parts) {
			if (!part.trim()) continue;
			let message;
			try {
				message = JSON.parse(part);
			} catch {
				continue;
			}
			deliver(message);
		}
	});
	socket.on("error", () => {});
	socket.on("close", () => {
		if (live === socket) live = void 0;
		if (quitting) return;
		if (opened) {
			app.quit();
			return;
		}
		if (attempt >= 30) {
			console.error("dsh-orb helper: host socket did not open");
			app.exit(1);
			return;
		}
		setTimeout(() => connect(attempt + 1), 300);
	});
}
function deliver(message) {
	if (overlays?.deliver(message)) return;
	if (typeof message !== "object" || message === null || !win) return;
	const record = message;
	if (record.type === "session") {
		win.webContents.send("orb:session", record.sessionId);
		return;
	}
	if (record.type === "block") {
		win.webContents.send("orb:block", message);
		return;
	}
	if (record.type === "block-drop") {
		win.webContents.send("orb:block-drop", record.key);
		return;
	}
	if (record.type === "image-data") {
		// 按需回传的历史图片（P2-4 补）。`{ key, images:[{mimeType,dataURL}], skipped }`
		// —— dataURL 已由 host 拼好 `data:<mime>;base64,…`，球侧直接塞 <img>.src
		//    （CSP `img-src 'self' data: blob:` 已放行 data:）。
		win.webContents.send("orb:image-data", message);
		return;
	}
	if (record.type === "turn") {
		win.webContents.send("orb:turn", message);
		return;
	}
	if (record.type === "status") {
		win.webContents.send("orb:status", record.text);
		return;
	}
	if (record.type === "question") {
		win.webContents.send("orb:question", message);
		return;
	}
	if (record.type === "question-clear") {
		win.webContents.send("orb:question-clear", record.id);
		return;
	}
	if (record.type === "question-error") {
		win.webContents.send("orb:question-error", message);
		return;
	}
	if (record.type === "permission") {
		win.webContents.send("orb:permission", record.preset);
		return;
	}
	if (record.type === "history") {
		win.webContents.send("orb:history", record.items);
		return;
	}
	if (record.type === "conversation-action-result") {
		// 对话级操作（重命名/删除/锁定/导出）的回执。
		// 少了这条转发，球侧失败时完全静默 —— 用户点了没反应又看不到提示。
		win.webContents.send("orb:conversation-action-result", {
			action: typeof record.action === "string" ? record.action : "",
			sessionId: typeof record.sessionId === "string" ? record.sessionId : "",
			ok: record.ok === true,
			title: typeof record.title === "string" ? record.title : "",
			error: typeof record.error === "string" ? record.error : "",
			// 锁定态与导出路径：加字段时**必须同步加到这里**，
			// 否则 host 算出来了、球侧永远读不到（「静默丢字段」这一族病的第二次出现）。
			locked: record.locked === true,
			needPassword: record.needPassword === true,
			path: typeof record.path === "string" ? record.path : "",
			bytes: typeof record.bytes === "number" ? record.bytes : 0
		});
		return;
	}
	if (record.type === "reset") {
		win.webContents.send("orb:reset");
		return;
	}
	if (record.type === "lock") {
		// ── 对话隐私锁：锁定态变更（对话加密_落地方案.md §9.2）────────────
		// host 在「进锁 / 解锁」时推这条，球侧据此切遮罩。
		//
		// ⚠️ 和 `deco` 一样，这里**必须有一个显式分支**：dispatchRecord 是
		//   一串 if，落不到任何分支就静默丢弃（host 日志写着「已推送」、
		//    球侧毫无反应、零异常）。这一族「静默丢弃」在本项目已经踩过三次
		//    （主进程 ReferenceError / deco 缺分支 /旧后端 otid 去重），
		//    症状全都是「点了/发了没反应」，所以每加一个协议类型都要配一条
		//    「这个分支存在吗」的源码断言。
		win.webContents.send("orb:lock", {
			state: record.state === "locked" ? "locked" : "unlocked",
			kind: record.kind === "strong" ? "strong" : "soft",
			convId: typeof record.convId === "string" ? record.convId : "",
			attemptsLeft: typeof record.attemptsLeft === "number" ? record.attemptsLeft : 0,
			hasAgreement: record.hasAgreement === true
		});
		return;
	}
	if (record.type === "lock-feedback") {
		// 一次解锁尝试的结果：对没对上、还剩几轮、给什么话。
		win.webContents.send("orb:lock-feedback", {
			ok: record.ok === true,
			kind: record.kind === "strong" ? "strong" : "soft",
			attemptsLeft: typeof record.attemptsLeft === "number" ? record.attemptsLeft : 0,
			message: typeof record.message === "string" ? record.message : ""
		});
		return;
	}
	if (record.type === "soft-agreement") {
		// 「用户取消/重设了暗号」的状态标记（方案 §4.4）。
		// 这是给鲸鱼娘读的**状态**（不是凭证），球侧只需知道当前有没有暗号。
		win.webContents.send("orb:soft-agreement", {
			state: record.state === "none" ? "none" : "set"
		});
		return;
	}
	if (record.type === "deco") {
		// ── 情绪 GIF 装饰层（P1-5）──────────────────────────────────────
		// host 侧从她的回复里剥掉 `(mood:xxx)` 标记后，把「该显示哪个情绪」
		// 推过来（`src/mood.mjs` 的 assetFor()）。
		//
		// ⚠️ 这里以前**根本没有这个分支** —— 记录走完dispatchRecord
		// 什么都不匹配，静默丢弃。症状是「她永远只有一张脸」，
		// 而且日志里一条异常都没有（host 侧日志写着「已推送」）。
		//
		// `src` 必须过 `PRESET_SRC`（只允许小写/数字/`_`/`-`、`/` 分隔、`.gif` 结尾），
		// 与 `readAvatarChoice` 用的是同一条正则 —— 素材目录里的原名
		// `happy@0.85x.gif` 过不了（`@` 和小数点都不合法），所以 host 侧
		// `tools/copy-deco.mjs` 统一拷成 `deco/happy.gif`。
		// 校验放在主进程，是为了让非法路径**在这里就被丢掉**，
		// 而不是变成渲染层一个加载失败的破图。
		if (typeof record.src !== "string" || !PRESET_SRC.test(record.src)) return;
		win.webContents.send("orb:deco", {
			mood: typeof record.mood === "string" ? record.mood : "idle",
			src: record.src,
			opacity: typeof record.opacity === "number" && Number.isFinite(record.opacity)
				? Math.min(1, Math.max(0, record.opacity))
				: 0.65,
			speed: typeof record.speed === "string" ? record.speed : "1x",
		});
		return;
	}
	// ── 语音播报（2026-10-22）────────────────────────────────────────
	// 三条都要有**显式分支**。dispatchRecord 是一串 if，落不到任何分支就静默丢弃
	// —— 这个坑在 deco / lock 上已经踩过两次，症状全是「host 日志写着已推送、
	//    球侧毫无反应、零异常」。加协议类型必须配分支，这条是硬规矩。
	//
	// `speech` 里带着音频字节（base64），不落盘、不进任何缓存，
	// 渲染层转 Blob 播完就 revoke。
	if (record.type === "speech") {
		if (typeof record.audio !== "string" || record.audio === "") return;
		win.webContents.send("orb:speech", {
			gen: typeof record.gen === "number" ? record.gen : 0,
			seq: typeof record.seq === "number" ? record.seq : 0,
			mime: typeof record.mime === "string" && record.mime ? record.mime : "audio/mpeg",
			audio: record.audio,
			chars: typeof record.chars === "number" ? record.chars : 0,
			ms: typeof record.ms === "number" ? record.ms : 0,
			preview: record.preview === true,
		});
		return;
	}
	if (record.type === "speech-stop") {
		win.webContents.send("orb:speech-stop", {
			gen: typeof record.gen === "number" ? record.gen : 0,
			reason: typeof record.reason === "string" ? record.reason : "",
		});
		return;
	}
	if (record.type === "speech-state") {
		win.webContents.send("orb:speech-state", {
			enabled: record.enabled === true,
			ready: record.ready === true,
			provider: typeof record.provider === "string" ? record.provider : "",
			providerLabel: typeof record.providerLabel === "string" ? record.providerLabel : "",
			variant: typeof record.variant === "string" ? record.variant : "",
			speaker: typeof record.speaker === "string" ? record.speaker : "",
			description: typeof record.description === "string" ? record.description : "",
			lastError: typeof record.lastError === "string" ? record.lastError : "",
		});
		return;
	}
	// ── 记忆中心（P0-7「我们的回忆」）─────────────────────────────────
	// host 侧六条协议已全部实现（见 `记忆中心_落地方案.md` §〇），
	// 这里**原样转发整个 record**，不逐字段映射。
	//
	// 为什么不做白名单投影：`impression` / `impression-history` / `impression-at` /
	// `impression-result` / `memory:archive-result` 的字段有二十多个且还在演进
	// （方案文档里每轮都会补字段），逐字段抄一遍必然漏 —— 而漏掉的字段在球侧
	// 表现为「某块信息永远是空的」，且没有任何报错。
	// 原样转发 = host 加字段球侧自动就有，零维护。
	if (IMPRESSION_TYPES.has(record.type)) {
		win.webContents.send("orb:impression", record);
		return;
	}
	if (record.type === "chrome") {
		chrome = readChrome(record);
		return;
	}
	if (record.type === "appearance") {
		const next = readAppearanceMessage(message);
		if (next.theme !== void 0) appearance.theme = next.theme;
		if (next.locale !== void 0) appearance.locale = next.locale;
		applyAppearance();
		return;
	}
	if (record.type === "avatar") {
		loadAvatar(readAvatarChoice(record));
		return;
	}
	if (record.type === "legacy-endpoint") {
		const http = record.http;
		legacyHttp = typeof http === "string" ? http : "";
		return;
	}
	if (record.type === "tcc") {
		const wait = tccWait;
		tccWait = void 0;
		wait?.(record.status);
	}
}
/** Ball plus overlays: the windows the host must skip when it picks an observation window. */
function chromeWindowIds() {
	return collectChromeWindowIds([win, ...overlays?.chromeWindows() ?? []], process.platform);
}
/**
 * 记忆中心（P0-7）的下行消息类型。
 *
 * 全部走同一个 `orb:impression` IPC 事件、**原样转发整个 record** ——
 * 理由见 `dispatchRecord` 里那条注释（字段有二十多个且还在演进，
 * 逐字段投影必然漏，而漏字段的症状是「某块信息永远空着」且不报错）。
 */
const IMPRESSION_TYPES = new Set([
	"impression",
	"impression-history",
	"impression-at",
	"impression-result",
	"memory:archive-result",
]);
function fromBall(event) {
	if (!win || win.isDestroyed()) return false;
	return event.sender === win.webContents;
}
function tccUnavailable() {
	return {
		applicable: false,
		appName: "",
		screen: "granted",
		accessibility: "granted"
	};
}
function askTcc(message) {
	const previous = tccWait;
	tccWait = void 0;
	previous?.(tccUnavailable());
	return new Promise((resolve$1) => {
		const timer = setTimeout(() => {
			if (tccWait !== finish) return;
			tccWait = void 0;
			resolve$1(tccUnavailable());
		}, 3e3);
		const finish = (status) => {
			clearTimeout(timer);
			resolve$1(status ?? tccUnavailable());
		};
		tccWait = finish;
		write(message);
	});
}
function write(message) {
	if (!live) return;
	live.write(`${JSON.stringify(message)}\n`);
}
function isMove(value) {
	if (typeof value !== "object" || value === null) return false;
	const point = value;
	return typeof point.x === "number" && typeof point.y === "number" && Number.isFinite(point.x) && Number.isFinite(point.y) && Math.abs(point.x) <= 1e5 && Math.abs(point.y) <= 1e5 && typeof point.canDock === "boolean";
}
function zhLocale() {
	return (app.getLocale?.() ?? process.env.LANG ?? "").toLowerCase().startsWith("zh");
}
/** Appearance seed from the host: the preferences as of helper launch. */
function readAppearanceEnv() {
	const raw = process.env.ORB_APPEARANCE;
	if (typeof raw !== "string" || raw.length > 200) return {};
	try {
		return readAppearanceMessage(JSON.parse(raw));
	} catch {
		return {};
	}
}
function themeSourceOr(value, fallback) {
	return value === "light" || value === "dark" || value === "system" ? value : fallback;
}
/** Accept only well-formed preference fields; anything else keeps the current value. */
function readAppearanceMessage(value) {
	if (typeof value !== "object" || value === null) return {};
	const record = value;
	const theme = themeSourceOr(record.theme, void 0);
	return {
		...theme === void 0 ? {} : { theme },
		...typeof record.locale === "string" && record.locale.length > 0 && record.locale.length <= 35 ? { locale: record.locale } : {}
	};
}
/**
* The UI language the ball mirrors: an explicit Host locale that names one of
* the shipped languages wins, otherwise follow the system like the web client
* falls back to its browser detection.
*/
function uiLanguage() {
	const preference = typeof appearance.locale === "string" ? appearance.locale.toLowerCase() : "";
	if (preference.startsWith("zh")) return "zh";
	if (preference.startsWith("en")) return "en";
	return zhLocale() ? "zh" : "en";
}
/** Menu and dialog copy follow the mirrored language, not the raw system locale. */
function menuZh() {
	return uiLanguage() === "zh";
}
/**
* Point the helper's theme at the stored preference and push the resolved state.
*
* ★ 用户的主题页选择（`window-state.json` 的 `theme`）优先于 host 推来的
*   appearance.theme：`auto` 才跟随 host，`light`/`dark` 直接顶掉。
*/
function applyStoredTheme() {
	const mode = loadStoredTheme();
	nativeTheme.themeSource = mode === "auto" ? appearance.theme ?? "system" : mode;
}
function applyAppearance() {
	applyStoredTheme();
	pushAppearance();
}
function pushAppearance() {
	const payload = {
		dark: nativeTheme.shouldUseDarkColors,
		locale: uiLanguage()
	};
	if (win && !win.isDestroyed()) win.webContents.send("orb:appearance", payload);
	overlays?.appearance(payload);
}
function readChrome(value) {
	const record = value;
	return {
		overlay: selectionOr(record.overlay, chrome.overlay),
		background: selectionOr(record.background, chrome.background),
		millifractionEnabled: record.millifractionEnabled === true,
		openMain: record.openMain === true,
		catalog: record.catalog ?? { groups: [] }
	};
}
function selectionOr(value, fallback) {
	if (!value || typeof value.provider !== "string" || typeof value.model !== "string") return fallback;
	return value;
}
async function showMenu(window) {
	const panel = placement?.getPanelSize() ?? {
		width: 320,
		height: 420
	};
	const template = contextMenuTemplate({
		zh: menuZh(),
		avatar: currentAvatar,
		panelSize: panel
	}, {
		setAvatar: (src) => {
			applyAvatar(src);
		},
		openLegacyWeb: () => {
			// ★ 与托盘同源：都走带兜底的入口。
			//   用户报「打开旧后端目前来说是无效的」时，这里和托盘是同一个静默失败，
			//   只修一边等于留一半 bug。
			openMainPageFromTray();
		},
		openHistory: () => {
			openHistoryPanel();
		},
		resetPanelSize: () => {
			resetPanelSize();
		},
		hideBall: () => {
			hideBall();
		},
		disable: () => {
			write({ type: "disable" });
		}
	});
	Menu.buildFromTemplate(template).popup({ window });
}
/** 换头像：校验后落盘 + 立刻推给渲染层 + 同步托盘图标。 */
function applyAvatar(src) {
	if (!isSafePresetSrc(src)) {
		console.error(`dsh-orb helper:拒绝不安全的头像路径 ${src}`);
		return;
	}
	setBallAvatar(src);
}
/**
* 球体头像的**唯一出口**：改 `currentAvatar` → 落盘 → 推渲染层 → 刷托盘。
*
* ★ 为什么必须收敛成一个函数：这只球以前有三处各自 `win.webContents.send("orb:avatar", …)`
*   （预设 / 默认 / 自定义 data URL）。托盘也要跟着变，如果继续各写各的，
*   迟早漏掉一条分支 —— 那就是「球换了、托盘没换」的不一致，且**没有任何报错**。
*   托盘图标的刷新挂在**这里**，而不是挂在某个调用点上。
*
* `src === ""` 表示用自带默认 GIF；`data:` 开头是自定义上传的头像。
*/
function setBallAvatar(src) {
	currentAvatar = src;
	saveStoredAvatar(src);
	win?.webContents.send("orb:avatar", src);
	refreshTrayIcon(src);
}
/** 打开旧后端自带的 Web 界面 —— 独立版意义上的「主窗口」。 */
function openLegacyWeb() {
	if (!legacyHttp) {
		console.error("dsh-orb helper: 还没有旧后端地址（Host 尚未连上）");
		return false;
	}
	shell.openExternal(legacyHttp);
	return true;
}
/**
 * 打开「看过的视频」抽屉（2026-10-21，取代原生菜单里的「打开旧后端界面」）。
 *
 * 抽屉住在渲染层（`shell.js` 的 biliHistoryPanel），主进程只能通过钩子请它开。
 * 先把球叫回来：球藏起来时点菜单，用户期望的是「我能看到东西了」。
 * 钩子不在（页面还在加载 / 版本不匹配）就只记一条日志 —— 不再退回旧后端那条死路。
 */
function openBiliHistory() {
	showBall();
	const wc = win && !win.isDestroyed() ? win.webContents : null;
	if (!wc || wc.isDestroyed()) {
		console.error("dsh-orb helper: 打开看过的视频 —— 球窗不可用");
		return;
	}
	wc.executeJavaScript(`(() => {
    if (typeof window.__orbOpenBiliHistory === 'function') {
      window.__orbOpenBiliHistory();
      return true;
    }
    return false;
  })()`).catch(() => {
		console.error("dsh-orb helper: 打开看过的视频 —— 渲染层钩子不可用");
	});
}
/**
 * 托盘/原生菜单专用的「显示主页面」入口 —— 刻意**不**直接调 openLegacyWeb()。
 *
 * ★ 为什么：`openLegacyWeb()` 在拿不到地址时是**静默 return**（只写一条 console.error）。
 *   渲染层本来为这一刻准备了兜底（`shell.js:4032-4046`）：地址为空就打开
 *   「API 配置」抽屉并给出提示 —— 但那要经过 `orb:open-legacy-web` 信道，
 *   而托盘是**主进程直连**，绕过了渲染层，于是又落回静默那条路。
 *   用户点「显示主页面」看到的是「什么也没发生」，比报错还难查。
 *
 * 所以这里改成三段式，**失败永远有去处**：
 *   ① 有球窗 ⇒ 让渲染层跑它那份带兜底的实现（能用抽屉解释原因）；
 *   ② 没有球窗（极端情况）或有地址 ⇒ 主进程直开；
 *   ③ 真的什么都没有 ⇒ 弹一个原生对话框说明「Host 未连上」，而不是静默。
 */
function openMainPageFromTray() {
	// 球藏起来时点「显示主页面」，用户期望的是「我能看到东西了」——
	// 所以先把它叫回来，再谈打开网页。
	showBall();
	const wc = win && !win.isDestroyed() ? win.webContents : null;
	if (wc && !wc.isDestroyed()) {
		// 走渲染层那条路：它内部会先问 legacyStatus，拿不到就开 API 配置抽屉。
		wc.executeJavaScript(`(() => {
      if (typeof window.__orbOpenLegacyWeb === 'function') {
        window.__orbOpenLegacyWeb();
        return true;
      }
      return false;
    })()`).then((handled) => {
			// 渲染层没挂上钩子（版本不匹配/页面异常）或直开也拿不到地址 ⇒ 弹原生框讲清楚，别静默。
			if (!handled && !openLegacyWeb()) notifyNoLegacyAddress();
		}).catch(() => {
			// 渲染层没就绪（比如页面还在加载）⇒ 退回主进程直连，至少把有地址的那种情况办了。
			if (!openLegacyWeb()) notifyNoLegacyAddress();
		});
		return;
	}
	console.error("dsh-orb helper: 显示主页面 —— 球窗不可用，退回主进程直开");
	if (!openLegacyWeb()) notifyNoLegacyAddress();
}
/**
 * 渲染层够不到时的**兜底提示**：原生对话框。
 *
 * 只在「连球窗都没有 / 渲染层脚本抛错」这种边缘情况下被调用。
 * 用 dialog 而不是 console：用户点按钮是为了看到反应，
 * 一条日志对他等于没有反应。
 */
function notifyNoLegacyAddress() {
	try {
		dialog.showMessageBox({
			type: "warning",
			title: "还没有旧后端地址",
			message: "Host 尚未连上，暂时打不开旧后端页面。",
			detail: "请在悬浮球的「API 配置」里确认地址，或稍后再试。",
			buttons: ["知道了"],
			noLink: true
		});
	} catch {}
}
/** 让球打开历史对话面板：借orb:attach 的通道不行（那是划词文本），走 toggle 语义。 */
function openHistoryPanel() {
	if (!win) return;
	win.webContents.executeJavaScript(`(() => {
    const btn = document.querySelector('[aria-label*="历史"], [aria-label*="istory"]')
    if (btn instanceof HTMLElement) btn.click()
    return true
  })()`).catch(() => {
		console.error("dsh-orb helper: 打开历史面板失败");
	});
}
/** 恢复默认面板尺寸。 */
function resetPanelSize() {
	if (!placement || !win) return;
	const display = screen.getDisplayNearestPoint(screenPointOf(win));
	const next = placement.setPanelSize(PANEL_SIZE_DEFAULT.width, PANEL_SIZE_DEFAULT.height, display.workArea);
	placement.setExpanded(true);
	win.getBounds();
	console.error(`dsh-orb helper: 面板尺寸已重置为 ${next.width}×${next.height}`);
}
function screenPointOf(window) {
	const b = window.getBounds();
	return {
		x: b.x + b.width / 2,
		y: b.y + b.height / 2
	};
}

//#region 托盘（系统通知区）
/**
* ★ 托盘图标（用户需求）：
*   1. **显示样式跟随球体** —— 球显示哪张 GIF，托盘就用哪张（取第一帧，托盘不支持动画）。
*   2. **动作** —— 显示·隐藏悬浮球 / 退出程序（两项，见 trayMenuTemplate）。
*
* ★ 2026-10-08 补「隐藏球体」的来龙去脉（用户原话「因为没做隐藏球体的按钮，
*   所以右下角的显示窗口目前来说是无效的」）：
*     托盘里原本有「显示主页面」，本意是「球藏起来后，从这里把窗口叫回来」。
*     但**球从来没有隐藏功能** ⇒ 这一项永远等不到它的使用场景 ⇒ 在用户眼里
*     它就是「一个点了没用的按钮」。修法不是删它，而是**把隐藏功能补上**，
*     让「显示」这件事第一次有了对象。
*     `ballHidden` 就是那个状态：true 时球窗 `hide()`，托盘图标仍在，
*     点托盘的「显示悬浮球」就能把它叫回来。
*
* ★ 2026-10-08 二次修订：隐藏补上之后，用户随手指出了「显示主页面」的冗余 ——
*   「既然托盘图标做了显示球，那么显示主界面这个选项也可以一并删除了」。
*   这个判断是对的：托盘已经有「显示悬浮球」，而球一回来右键就能进旧后端界面，
*   中间那一跳多余。所以托盘回到两项。
*   ⚠️ 注意：删的只是**托盘这一份入口**，`openMainPageFromTray()` 本身保留 ——
*   原生右键菜单的「打开旧后端界面」还在用它（那条路同样要「先叫回球 + 失败有去处」）。
*
* 为什么图标要从 `currentAvatar` 推、而不是内置一张固定图：
*   球窗口是 `skipTaskbar: true` 的，任务栏上看不到它 —— 托盘是它**唯一的常驻入口**。
*   用户换头像后如果托盘还是旧形象，两者会像两个不相干的程序，所以必须同源。
*
* ★★ 为什么图标**必须由渲染层解码**（2026-10-08 实测，别改回去）：
*   `nativeImage.createFromPath()` 对 GIF 返回**空图**（`isEmpty()===true` / `0×0`）——
*   Electron 的 nativeImage 只解 PNG / JPEG，**不解析 GIF**。而本项目的头像素材**全是 GIF**。
*   实测对照（probe/tray-icon-bench.cjs）：GIF 7.4MB → isEmpty=true；
*   PNG 1.6MB → isEmpty=false、2048×2048 正常。
*
*   这个坑的可怕之处：**`Tray` 接受空图不抛错**，`setImage()` 也不报错 ——
*   症状只是「托盘出现一个空位 / 图标是空白」，
*   而所有日志干干净净 —— 又是「静默失败族」。
*
*   所以走渲染层：Chromium **支持** GIF。让球的页面把当前头像画进 canvas、
*   取首帧导出 PNG data URL 回传，主进程 `createFromDataURL` 拿到真位图。
*   附带好处：每张 GIF 只在换头像时解码一次，且「球显示什么就画什么」，天然一致。
*/
const TRAY_ICON_SIZE = 16;
/** 自带默认头像（与 AVATAR_PRESETS[0] 同一份、也是渲染层 default 用的那张）。 */
const DEFAULT_AVATAR_SRC = "avatars/orb-A.gif";
/** 头像素材在磁盘上的绝对路径。 */
function avatarFilePath(src) {
	return join(PROJECT_ROOT, "helper", "assets", src);
}
/**
* 兜底图标：一张纯色圆点（16×16，边缘抗锯齿，深蓝 #2B4A9E）。
* 万一渲染层还没就绪 / 解码失败，托盘至少有个可见的东西，
* 而不是一个空白格子。用 data URL 而非磁盘文件，免掉「打包漏素材」这个变量。
*
* ★ 这张图的 base64 是 `probe/gen_fallback_icon.py` 现场生成的**有效 PNG**
*   （160 字节，`iVBORw0KGgo` 开头 = 标准 PNG 签名）。上一版是手写/拼凑的，实测
*   `createFromDataURL` 出来 `isEmpty()===true` ⇒ `createTray()` 直接 bail
*   ⇒ **托盘根本不会出现**，而且日志只有一行 error。
*   `probe/tray-logic-test.mjs` 里有专门的断言钉住它，防它再变回坏图。
*/
const TRAY_FALLBACK_PNG =
	"data:image/png;base64," +
	"iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAZ0lEQVR42mNgoDbQ9prHAsSpQLwS" +
	"iM9A8UqoGAshzS5QDf9xYJCcCz7NH/BohuEPGIZAnX2GCM3ILmFBNiCVBM0wnIpswEoyDFiJbMAZ" +
	"Mgw4Q1UDKPYCxYFIWTRSnJCokpSpkpnIAQCyWkuM40WibQAAAABJRU5ErkJggg==";
/**
* 固定托盘图标：`helper/assets/tray.ico`（多尺寸 16/20/24/32/48/64/128/256，一张文件系统自己挑）。
*
* ★ 2026-10-22 用户换图：托盘原来跟「球当前头像」走 —— 换头像托盘也换，
*   好处是形象一致，坏处是托盘上出现的是**球形态素材**而不是这个项目的标识。
*   现在改为固定图标，头像再怎么换托盘都不动；`.ico` 里带多尺寸，托盘在
*   不同 DPI 下取不同尺寸，不会像单张 PNG 那样被拉糊。
*
*   素材由 `tools/make_tray_icon.py` 从一张圆形徽章图生成（裁圆形 + 外部透明），
*   换图不要手改这里，重跑那个脚本即可。
*   文件缺失 / 解不出来时**退回下面那张蓝点兜底图**（不抛错、不影响启动）。
*/
const TRAY_ICON_FILE = join(PROJECT_ROOT, "helper", "assets", "tray.ico");
/**
* 固定图标的候选文件，**按优先级**：先 `.ico`（内含 16/20/24/32/48/64/128/256 多尺寸，
* 系统按 DPI 自己挑，16px 那档是专门画过的，不会糊），再退 `.png`（单张 256）。
* 为什么不一上来就用 png：256 缩到 16 是「缩出来的」，细描边会灰掉一圈。
* 为什么 .ico 可能解不出来还要留它在前：`nativeImage.createFromPath` 官方只保证
* PNG/JPEG，.ico 在某些 Electron 版本上返回空图 —— 所以两条都要能被尝试。
*/
const TRAY_ICON_CANDIDATES = [TRAY_ICON_FILE, join(PROJECT_ROOT, "helper", "assets", "tray.png")];
/** 取固定托盘图标；候选项都没有或全是坏图时返回 null（调用方自己退到兜底）。 */
function loadFixedTrayImage() {
	for (const file of TRAY_ICON_CANDIDATES) {
		try {
			if (!existsSync(file)) continue;
			const image = nativeImage.createFromPath(file);
			if (image && !image.isEmpty()) return image;
			console.error(`dsh-orb helper: ${file} 解不出位图（空图），试下一个`);
		} catch (err$1) {
			console.error(`dsh-orb helper: 读取 ${file} 失败，试下一个`, err$1);
		}
	}
	console.error("dsh-orb helper: 没有可用的固定托盘图标，退回兜底蓝点");
	return null;
}
/**
* 托盘菜单。
*
* ★ 2026-10-08 用户拍板（第二次修订）：**只留两项**。
*
*   演进过程：原定两项（显示主页面 / 退出程序）→ 加隐藏功能后变三项
*   → 用户发现「既然托盘已经有显示球，那『显示主页面』就是多余的」，删回两项。
*
*   为什么删「显示主页面」成立：它原本存在的唯一理由，是「球藏起来之后
*   有个地方能把东西叫回来」。但现在托盘自己就有一项「显示悬浮球」，
*   而**只要球回来了，右键球就能进旧后端界面** —— 中间那一跳没必要。
*   两个入口做同一件事，只会让用户犹豫点哪个。
*
*   最终两项：显示·隐藏悬浮球 → 退出程序。
*   最后一项是破坏性操作，用 separator 隔开。
*
* ★ 但「显示主页面」这个**能力**没删，只是不再挂在托盘上：
*   `openMainPageFromTray()` 保留，原生右键菜单的「打开旧后端界面」仍在用它
*   （那条路同样需要「先叫回球 + 失败有去处」）。删的只是托盘这份重复入口。
*/
function trayMenuTemplate() {
	return [
		{
			// 文案随状态翻转 —— 用户不必猜现在是什么状态、点下去会怎样。
			label: ballHidden ? "显示悬浮球" : "隐藏悬浮球",
			click: () => {
				// ★ 不用在这里 refreshTrayMenu()：hideBall/showBall **自己**会刷
				//   （2026-10-08 第三轮修的 —— 刷托盘原来写在这里，于是从环菜单
				//   隐藏时文案不翻转，用户就看到「球已经藏了，托盘还写着隐藏悬浮球」）。
				//   状态变更和它的副作用必须收在同一个函数里，别推给调用方。
				if (ballHidden) showBall();
				else hideBall();
			}
		},
		{ type: "separator" },
		{
			label: "退出程序",
			click: () => {
				// 走 app.quit() 而不是 process.exit：before-quit 里要 `live?.destroy()` 收 socket，
				// 直接退会让 Host 侧留着一条半死连接。
				app.quit();
			}
		}
	];
}
/**
* 把渲染层回传的 PNG data URL 装成一个托盘图标（NativeImage）。
* 失败返回 null（调用方走兜底）。
*
* ★★ 为什么是**一张**图而不是一组尺寸（2026-10-08 实测，别改回去）：
*   我本来想按 DPI 给 [16,20,24,32] 四张，让系统自己挑。实测
*   `probe/tray-api-check.cjs`：
*     `tray.setImage(NativeImage[])` → 抛 `Argument must be a file path or a NativeImage`
*     `new Tray(NativeImage[])`      → 抛同一句
*   即 Electron 的托盘 API **只吃单张 NativeImage**（或多尺寸的 .ico 文件路径），
*   不吃数组。所以这里只尺寸化到 16×16，交给系统缩放。
*/
function trayImageFromDataUrl(dataUrl) {
	try {
		const base = nativeImage.createFromDataURL(dataUrl);
		if (!base || base.isEmpty()) return null;
		// 渲染层已经按 face-crop 画好方图；这里再规整到 16×16 的托盘逻辑尺寸。
		const sized = base.resize({
			width: TRAY_ICON_SIZE,
			height: TRAY_ICON_SIZE,
			quality: "best"
		});
		return sized && !sized.isEmpty() ? sized : base;
	} catch {
		return null;
	}
}
/** 真正把图标贴到托盘上（失败返回 false，让调用方知道没贴成）。 */
function applyTrayImage(image) {
	if (!tray || tray.isDestroyed() || !image || image.isEmpty()) return false;
	trayImage = image;
	tray.setImage(image);
	return true;
}
/**
* 让**渲染层**把 src 对应的头像裁好、画成 PNG 回传，再贴到托盘。
*
* `src` 为空串 = 用自带默认 GIF。渲染层里球的头像元素就是真源，
* 所以这里直接把当前头像的 src 喂给它，让它负责解码 + 人脸裁切
* （裁切参数在 shell.js 的 TRAY_FACE_CROP，逐图定参）。
*
* 为什么不 await：换头像是 UI 动作，不该被图片解码阻塞；
* `trayIconToken` 保证「快切多次只认最后一次」，避免旧图后到覆盖新图。
*/
function refreshTrayIcon(src) {
	if (!tray || tray.isDestroyed()) return;
	// ★ 有固定托盘图标时，头像怎么换托盘都不动 —— 同 TRAY_ICON_FILE 的注释。
	//   这条要在 `!win` 判空之前：固定图标不依赖渲染层，球页没装好也该能贴上。
	const fixed = loadFixedTrayImage();
	if (fixed) {
		applyTrayImage(fixed);
		return;
	}
	if (!win) return;
	const tokenId = ++trayIconToken;
	const target = src || DEFAULT_AVATAR_SRC;
	// 渲染层的浮动页知道怎么把预设路径变成一个可画的 URL；data URL 直接给。
	const payload = src && src.startsWith("data:") ? src : target;
	win.webContents
		.executeJavaScript(
			`window.__orbTrayIconPng ? window.__orbTrayIconPng(${JSON.stringify(payload)}) : null`
		)
		.then((dataUrl) => {
			if (tokenId !== trayIconToken || !dataUrl || typeof dataUrl !== "string") return;
			const image = trayImageFromDataUrl(dataUrl);
			if (image) applyTrayImage(image);
			else console.error("dsh-orb helper: 渲染层回传的托盘图标无法解析（空图）");
		})
		.catch(() => {
			console.error("dsh-orb helper: 托盘图标解码失败（渲染层未响应）");
		});
}
/** 创建托盘。必须在 app.whenReady() 之后调用（Tray 依赖 GUI 就绪）。 */
function createTray() {
	if (tray && !tray.isDestroyed()) return tray;
	// 先用固定图标（或兜底图）建出来 —— 保证「托盘一定存在」。
	// 固定图标缺失时才退回旧逻辑：等渲染层装好后用头像换（did-finish-load 里会 refresh）。
	const initial = loadFixedTrayImage() ?? trayImageFromDataUrl(TRAY_FALLBACK_PNG);
	if (!initial) {
		// ★ 这里绝不能静默：兜底图若又变回坏 base64，托盘会整个消失，
		//   而症状只是「任务栏里少了个图标」，没有任何异常。
		console.error("dsh-orb helper: 托盘兜底图标构造失败（base64 可能是坏图），托盘未创建");
		return void 0;
	}
	tray = new Tray(initial);
	trayImage = initial;
	tray.setToolTip("鲸鱼娘");
	tray.setContextMenu(Menu.buildFromTemplate(trayMenuTemplate()));
	// ★ 左键单击不要自己弹菜单：Tray 没有 popupContextMenu（那是 BrowserWindow 的方法），
	//   之前在这里调它，会在「真双击」时抛 TypeError 崩溃（探针测不到，只有人点才炸）。
	//   Windows 上左键单击托盘本就会弹出 setContextMenu 设好的菜单，无需额外接线。
	console.error("dsh-orb helper: 托盘已创建");
	return tray;
}
//#endregion


async function loadAvatar(choice) {
	const tokenId = ++avatarToken;
	if (!win) return;
	if (choice.kind === "preset") {
		setBallAvatar(choice.src);
		return;
	}
	if (choice.kind === "default") {
		setBallAvatar("");
		return;
	}
	const image = await fetchAvatar(choice.version);
	if (tokenId !== avatarToken || !win || !image) return;
	setBallAvatar(`data:${image.mime};base64,${image.body.toString("base64")}`);
}
function fetchAvatar(version) {
	const port = Number(webPort);
	if (!Number.isInteger(port) || port <= 0 || !token) return Promise.resolve(void 0);
	return new Promise((resolve$1) => {
		const req = request({
			hostname: "127.0.0.1",
			port,
			path: `/.dsh-orb/avatar?v=${Math.trunc(version)}`,
			method: "GET",
			headers: { "x-dsh-orb-helper": token }
		}, (res) => {
			const chunks = [];
			let size = 0;
			res.on("data", (chunk) => {
				size += chunk.length;
				if (size > 25e5) {
					req.destroy();
					resolve$1(void 0);
					return;
				}
				chunks.push(chunk);
			});
			res.on("end", () => {
				if (res.statusCode !== 200) {
					resolve$1(void 0);
					return;
				}
				resolve$1({
					mime: (typeof res.headers["content-type"] === "string" ? res.headers["content-type"].split(";")[0] : "image/gif") ?? "image/gif",
					body: Buffer.concat(chunks)
				});
			});
		});
		req.setTimeout(5e3, () => {
			req.destroy();
			resolve$1(void 0);
		});
		req.on("error", () => resolve$1(void 0));
		req.end();
	});
}

//#endregion

//#region 环形菜单独立窗口（orb:ring-*）
/**
 * 环形菜单（方案C · 独立窗口）—— MateEngine 观感复刻版。
 *
 * ★ 下面三个几何常量必须与 `helper/assets/ring-geometry.js` 的 DEFAULT_RING 一致。
 *   探针 `probe/ring-geometry-test.mjs` 会**正则解析本文件**断言两边相等
 *   （纪律同 `probe/handles-vs-menu-test.mjs`：断言要从产品文件里抽数字，
 *   不能抄探针作者记忆里的数字）。所以这里刻意写成裸字面量 ——
 *   别改成从 ring-geometry.js import 算出来的表达式，那会让探针失去交叉校验的意义。
 */
const RING_OUTER_D = 248;
const RING_BAND = 40;
const RING_PAD = 16;
/**
 * ★ 阴影余量（2026-10-08 第四轮）：给 `#plane` 的 `box-shadow: 0 22px 54px` 留的透明边。
 *   之前窗口只有 RING_PAD×2 的留白，阴影外扩 22 + 54/2 = **49px** 被窗口边界
 *   **垂直切平** —— 用户看到环菜单上「一个隐约的方块」就是这个
 *   （逐像素量过截图，方块边缘正好压在窗口足迹上）。
 *   这个值只影响**窗口尺寸**，环的外径/图标/命中区一个像素都不动（见 ring-menu.css #plane,#band）。
 *   56 = 49 + 7 余量；断言 probe/ring-geometry-test.mjs §5.2 会从 CSS 反算实际外扩卡这一条。
 */
const RING_SHADOW_ROOM = 56;
const RING_WINDOW_SIZE = RING_OUTER_D + (RING_PAD + RING_SHADOW_ROOM) * 2;
/** 用上面几个字面量构造出的完整几何（推导尺寸一律从 ring-geometry.js 来，不在这里另算一套）。 */
const RING_GEO = ringLayout({ outer: RING_OUTER_D, band: RING_BAND, pad: RING_PAD, shadowRoom: RING_SHADOW_ROOM });
let ringWin = null;
/**
 * ★ `ringAnchor` 已删除（2026-10-08），**两版都没对**，过程记在这里防再犯。
 *
 *   第一版：存「球心在球窗口视口里的坐标」。窗口一收缩（面板 → 球尺寸）
 *           这个相对偏移就过期，叠加在缩小后的窗口原点上 ⇒ 菜单飞出去。
 *   第二版：以为「球永远贴窗口左上角」，改成 `bounds + CHROME_INSET + 半径`。
 *           **仍错** —— 展开态球贴的是窗口的右边/下边（看 direction），
 *           停靠态球也不在左上角。用户第二次反馈「这个bug还在」就是踩在这。
 *
 *   现在：`ballCenterScreen()` 直接问 `placement.currentBallOrigin()` ——
 *         那是唯一真正知道「球在窗口哪一角」的地方。**不要有第二个真相源。**
 */
let ringMoveBound = false;
/** 最近一次球窗口推来的菜单项。环窗口每次打开都要重放一份（清单源头只有 shell.js 一处）。 */
let ringItems = [];

function openRingMenuWindow() {
  if (ringWin && !ringWin.isDestroyed()) return ringWin;
  ringWin = new BrowserWindow({
    width: RING_WINDOW_SIZE,
    height: RING_WINDOW_SIZE,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    focusable: false,
    show: false,
    backgroundColor: "#00000000",
    roundedCorners: false,
    webPreferences: {
      preload: fileURLToPath(new URL("../preload-ring.cjs", import.meta.url)),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  ringWin.setAlwaysOnTop(true, "screen-saver");
  ringWin.webContents.on("context-menu", (e) => e.preventDefault());
  // 起步就穿透：ignore=true 且 forward=true 时 mousemove 照样送进渲染层，
  // 渲染层算出光标是否压在环带上，再回头把穿透关掉 —— 于是「环带能点、中心孔与环外全穿透」。
  setRingClickThrough(true);
  // 几何只从主进程单向下发（query 参数）：渲染层不自己抄一份尺寸，改一处即可。
  ringWin.loadFile(fileURLToPath(new URL("../assets/ring-menu.html", import.meta.url)), {
    query: {
      outer: String(RING_OUTER_D),
      band: String(RING_BAND),
      pad: String(RING_PAD),
      shadowRoom: String(RING_SHADOW_ROOM),
    },
  });
  ringWin.on("closed", () => {
    ringWin = null;
  });
  return ringWin;
}

function setRingClickThrough(passThrough) {
  if (!ringWin || ringWin.isDestroyed()) return;
  try {
    ringWin.setIgnoreMouseEvents(passThrough === true, { forward: true });
  } catch {}
}

/**
 * 把菜单项、当前透明度与**可见弧**推给环窗口。
 * 菜单项清单的源头是球窗口 shell.js 的 `ringItems()`；
 * `arc` 是屏幕里可见的那段弧（整圈可见时为 null），渲染层据此把图标铺进屏幕内。
 */
function sendRingData() {
  if (!ringWin || ringWin.isDestroyed()) return;
  ringWin.webContents.send("ring-menu:data", {
    items: ringItems,
    opacity: loadStoredPanelOpacity(),
    arc: currentRingArc(),
  });
}

function closeRingMenuWindow() {
  if (!ringWin || ringWin.isDestroyed()) return;
  ringWin.hide();
  if (win && !win.isDestroyed()) {
    // 通知球窗口「菜单关了」：左右键互斥的判断依赖这个状态准不准
    win.webContents.send("orb:ring-state", false);
    // 菜单一关，球必须立刻可点（左键开面板 / 右键再开菜单）。窗口刚才是可点的，
    // 这里再兜一次，避免任何残留的穿透态把球卡住。
    try {
      win.setIgnoreMouseEvents(false);
    } catch {}
  }
}

/**
 * 光标这个屏幕点是否落在**环带**上（不含中心孔与环外）？
 *
 * 两个用途：
 *  ① 打开菜单那一瞬间若光标已经压在环带上，就直接把窗口设成「可点」。
 *     否则要等下一次 mousemove 才从穿透切成可点，而光标不动时那条 mousemove 不会来 ——
 *     用户体感就是「菜单出来了但点不动」。
 *  ② 探针 probe/ring-geometry-test.mjs 对同一套几何做交叉断言。
 * 环带圆心 = 窗口中心（渲染层 #ring 是 translate(-50%,-50%) 居中，几何只有一个来源）。
 */
function ringBandHitAt(bounds, point) {
  const cx = bounds.x + bounds.width / 2;
  const cy = bounds.y + bounds.height / 2;
  const r = Math.hypot(point.x - cx, point.y - cy);
  const rOuter = RING_OUTER_D / 2;
  const rInner = (RING_OUTER_D - RING_BAND * 2) / 2;
  return r <= rOuter + 4 && r >= rInner - 4;
}

/**
 * 计算环菜单窗口的位置：**中心恒等于球心**，不夹取。
 *
 * ★ 2026-10-07 用户 m01036 反馈「球体没有出现在菜单的中央」——
 *   根因就是这里原来把窗口夹进工作区：贴边时窗口被推回来，环心最多偏离球心 92px，
 *   于是球歪在中心孔的一侧（用户截图里球明显偏下）。
 *   现在改成圆心 = 球心：球永远在菜单正中央。
 *   代价是贴边时整圈会被屏幕切掉一块 —— 落在屏幕外的图标看不见也点不到，
 *   所以配套做了 `currentRingArc()`：把屏幕里**真实可见**的那段弧下发给渲染层，
 *   图标全部铺在弧内（见 assets/ring-geometry.js 的 visibleItemArc）。
 */
function ringWindowBounds(screenX, screenY) {
  const half = RING_WINDOW_SIZE / 2;
  return {
    x: Math.round(screenX - half),
    y: Math.round(screenY - half),
    width: RING_WINDOW_SIZE,
    height: RING_WINDOW_SIZE
  };
}

/** 球心所在显示器的工作区（喂给 visibleItemArc 做可见性判定）。 */
function ringWorkArea(screenX, screenY) {
  return screen.getDisplayNearestPoint({
    x: Math.round(screenX),
    y: Math.round(screenY)
  }).workArea;
}

/**
 * 当前这一帧「图标环」可见的那段弧（整圈可见时返回 null）。
 * 每次下发数据都重算 —— 窗口位置和跟随球移动都会改变可见范围。
 */
function currentRingArc() {
  if (!ringWin || ringWin.isDestroyed()) return null;
  const bounds = ringWin.getBounds();
  try {
    return visibleItemArc(RING_GEO, bounds, ringWorkArea(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2));
  } catch {
    return null;
  }
}

/**
 * 球心在**屏幕**坐标里的位置。环菜单跟随球移动全靠它。
 *
 * ★★★ 2026-10-08 第三次修订 —— 前两版都错了，记在这里防再犯。
 *
 *   用户第二次报「环形菜单乱飞这个bug还在」，说明只靠「窗口原点 + 常量偏移」
 *   推球心是**错的**。错在哪：球**不是**永远贴在窗口左上角。
 *
 *     - 展开态：面板朝 `direction` 长出去（expandDirection），
 *       `horizontal==="left"` 时球贴窗口**右**边、`vertical==="up"` 时球贴窗口**下**边。
 *       这时按「左上角 + inset」算，能差出整个面板宽度（→ 菜单飞到远处）。
 *     - 停靠态：窗口是 96×88 的贴边竖条，球在 `dockedTabBounds` 里
 *       被放在 `ballY - DOCK_GLOW`，同样不是左上角。
 *
 *   为什么会踩到展开态：拖动第一帧渲染层调 `setExpanded(false)` 把窗口收缩，
 *   但那是一次异步 resize；紧接着的 `placement.move()` 里
 *   `if (!isCollapsed(this.window.getBounds()) && this.docked === void 0)`
 *   **可能仍读到「还没缩完」的展开尺寸**，于是走 `overlayBoundsFromBall`
 *   那条**球在右下角**的分支 —— 那一刻用左上角公式，菜单必然飞出去。
 *   （我的探针没抓到，是因为它在改 bounds 前先手动缩到了 96×96，
 *     等于把这条真实时序跳过了。）
 *
 *   ⇒ 修法：**不再自己从 bounds 反推**，直接问唯一知道答案的人 ——
 *     `placement.currentBallOrigin()`。它内部已经把三种状态（停靠 / 收起 / 展开）
 *     都处理好了（见 FloatingPlacement.currentBallOrigin / ballOriginFromWindow）。
 *     这正是项目里反复踩出来的那条铁律：**不要有第二个真相源**。
 *     没有 placement（极早期/测试环境）时才退回「左上角」近似。
 */
function ballCenterScreen() {
	// 权威来源：placement 知道自己现在是停靠/收起/展开，也只有它知道球在窗口的哪一角。
	const origin = placement?.currentBallOrigin?.();
	if (origin) {
		return {
			x: origin.x + BALL_SIZE / 2,
			y: origin.y + BALL_SIZE / 2
		};
	}
	// 兜底（placement 还没建好时的极早期调用）：球窗口收起态球贴左上角。
	const b = win?.getBounds?.();
	if (!b) return null;
	return {
		x: b.x + CHROME_INSET + BALL_SIZE / 2,
		y: b.y + CHROME_INSET + BALL_SIZE / 2
	};
}

/**
 * 球窗口被拖动（或程序改变其位置/尺寸）时，环菜单跟着球心走，并重算可见弧。
 *
 * ★ 用 `ballCenterScreen()`（内部走 placement.currentBallOrigin）而不是自己反推 —— 见上。
 * ★ 环窗口还没显示时直接返回，避免拖动球却没开菜单时白白重排。
 */
function repositionRingMenuWindow() {
	if (!ringWin || ringWin.isDestroyed() || !ringWin.isVisible() || !win) return;
	const center = ballCenterScreen();
	if (!center) return;
	ringWin.setBounds(ringWindowBounds(center.x, center.y));
	// 位置变了 → 可见范围可能也变了（球贴近屏幕边缘时），重新下发一次图标布局
	sendRingData();
}

// 球窗口请求打开环形菜单：clientX, clientY 是球心相对于球窗口视口的坐标
ipcMain.on("orb:ring-open", (event, clientX, clientY, items) => {
  if (!fromBall(event) || !win) return;
  const w = openRingMenuWindow();
  // ★ 菜单项只收形状合法的条目，避免渲染层拿到 undefined 生成空按钮
  if (Array.isArray(items)) {
    ringItems = items
      .filter((item) => item && typeof item.id === "string" && item.id !== "")
      .map((item) => ({ id: item.id, label: typeof item.label === "string" ? item.label : "" }));
  }
  if (!ringMoveBound) {
    ringMoveBound = true;
    // Electron 的 move 在程序自己 setBounds 时也会触发，这里靠 isVisible 过滤。
    // ★ 也要挂 resize：拖动第一帧窗口先**改尺寸**（面板 → 球），那一刻球的「角」
    //   会从右下角跳到左上角 —— 只靠 move 事件会漏掉这一跳（尺寸变了但原点没变时
    //   不一定派发 move），环窗口就会停在按旧角算出来的位置 = 用户看到的「飞出去」。
    const follow = () => repositionRingMenuWindow();
    win.on("move", follow);
    win.on("resize", follow);
  }
  // ★ 摆放位置一律用**球心屏幕坐标**（ballCenterScreen，内部走 placement.currentBallOrigin），
  //   不用渲染层传来的视口偏移、也不自己从 bounds 反推 —— 两者都会在
  //   「窗口正在收缩/展开、球队不在左上角」时算错，正是「拖动时菜单飞出去」的根因。
  const center = ballCenterScreen();
  if (!center) return;
  const placed = ringWindowBounds(center.x, center.y);
  w.setBounds(placed);
  if (win && !win.isDestroyed()) {
    try {
      win.setIgnoreMouseEvents(false);
    } catch {}
  }
  // 按**真实光标位置**定初始穿透态：光标已经压在环带上就直接可点，别等 mousemove。
  setRingClickThrough(!ringBandHitAt(placed, screen.getCursorScreenPoint()));
  const show = () => {
    if (!ringWin || ringWin.isDestroyed()) return;
    sendRingData();
    ringWin.showInactive();
    if (win && !win.isDestroyed()) win.webContents.send("orb:ring-state", true);
  };
  if (w.webContents.isLoading()) {
    w.once("ready-to-show", show);
    // 兜底：透明窗口的 ready-to-show 在某些系统上会迟迟不触发（或在本监听挂上之前就已触发过），
    // 那时菜单就是「点了没反应 / 要多点几次」——正是用户报的观感。500ms 后强推一次。
    setTimeout(() => {
      if (ringWin && !ringWin.isDestroyed() && !ringWin.isVisible()) show();
    }, 500);
  } else show();
});

// 环形菜单窗口请求关闭（点击环外 / ESC / 光标离开环带）。
// ★ 也接受球窗口发来的关闭：球窗口的 ESC 与「展开面板」都要能收起环菜单。
ipcMain.on("orb:ring-close", (event) => {
  if (!ringWin || ringWin.isDestroyed()) return;
  if (event.sender !== ringWin.webContents && event.sender !== win?.webContents) return;
  closeRingMenuWindow();
});

// 环带命中开关：true = 环带要吃鼠标事件（可点可拖），false = 穿回桌面/球窗口
ipcMain.on("orb:ring-hit", (event, interactive) => {
  if (!ringWin || event.sender !== ringWin.webContents) return;
  setRingClickThrough(interactive !== true);
});

// 拖动外侧透明度环：夹取 → 落盘 → 推给球窗口即时生效
ipcMain.on("orb:ring-opacity", (event, value) => {
  if (!ringWin || event.sender !== ringWin.webContents) return;
  const opacity = saveStoredPanelOpacity(value);
  if (win && !win.isDestroyed()) win.webContents.send("orb:panel-opacity", opacity);
});

// 环形菜单菜单项点击：回传给球窗口的 handleMenuAction
ipcMain.on("orb:ring-action", (event, id) => {
  if (ringWin && event.sender === ringWin.webContents) {
    // ★ 例外：`ball-hide` 由**主进程直接执行**，不回传球窗口。
    //
    //   原因：环菜单的其余动作（头像/回忆/历史/新建对话）目的地都在 #panel 里，
    //   所以球窗口那边统一先 `setExpanded(true)` 再办（见 shell.js 的 runRingAction）。
    //   但「隐藏悬浮球」恰恰相反 —— 它要的是「球别挡着我」，
    //   先展开面板等于反着来（还会一闪）。隐藏是**主进程的状态**，
    //   直接调 hideBall() 最短、最不容易出岔。
    if (String(id) === "ball-hide") {
      closeRingMenuWindow();
      hideBall();
      return;
    }
    closeRingMenuWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send("orb:ring-action", String(id ?? ""));
    }
  }
});
// ──旧后端时代的「API 配置」读写已整段删除（2026-10-19）
// 那一段写的是 `~/.legacy/.../providers/auth.json` 与 agent json 的 model_settings ——
// engine=local 下这两样都没有读侧（密钥真源已是 <dataRoot>/providers/auth.json）。
// 现在「设置」抽屉的读写归 src/main.mjs 的 apiConfigSnapshot / applyApiConfig，
// 通道名仍是 orb:api-config-get / orb:api-config-set —— **这里不能再注册同名通道**，
// ipcMain.handle 重复注册会抛，整个 helper 加载失败、球窗口都出不来。
ipcMain.handle("orb:legacy-status", () => ({ http: legacyHttp }));

/**
 * ── 主题与背景（用户 m02033「环形菜单加主题菜单：黑白切换 + 三个页面各自导背景」）
 *
 * 读写全在主进程，渲染层只收集输入（同 API 配置那条纪律）。这里没有
 * 「覆盖用户原文件」的动作 —— 导入是把用户选的图**复制**进
 * `helper/assets/backgrounds/`，原文件一个字节都不动，所以不需要 `.bak` 备份。
 *
 * 三个槽对应面板里三个可切换的页面：chat=#transcript、history=#history-list、
 * recall=#impression（「我们的回忆」）。抽屉级页面（API 配置 / 主题 / 锁卡）
 * 沿用聊天页背景。
 */
const BG_DIR = join(PROJECT_ROOT, "helper", "assets", "backgrounds");
const BG_EXTS = ["png", "jpg", "jpeg", "webp", "gif"];
const BG_MAX_BYTES = 32 * 1024 * 1024;

function themeSnapshot() {
  return { ok: true, mode: loadStoredTheme(), dark: nativeTheme.shouldUseDarkColors === true };
}

function pushTheme() {
  const payload = themeSnapshot();
  if (win && !win.isDestroyed()) win.webContents.send("orb:theme", payload);
  return payload;
}

function backgroundsSnapshot() {
  const stored = loadStoredBackgrounds();
  const slots = {};
  for (const slot of BG_SLOTS) {
    const entry = stored[slot] ?? normalizeBgSlot(null);
    // 文件被人从磁盘上删掉时按「没设背景」处理，别把 404 丢给 CSS。
    const file = entry.file !== "" && existsSync(join(BG_DIR, entry.file)) ? entry.file : "";
    slots[slot] = {
      file,
      url: file === "" ? "" : `backgrounds/${file}`,
      fit: entry.fit,
      scrim: entry.scrim,
    };
  }
  return { ok: true, dir: BG_DIR, slots };
}

function pushBackgrounds() {
  const payload = backgroundsSnapshot();
  if (win && !win.isDestroyed()) win.webContents.send("orb:backgrounds", payload);
  return payload;
}

function failBg(slot) {
  return { ok: false, error: `未知的背景槽「${slot}」，只认 ${BG_SLOTS.join(" / ")}` };
}

ipcMain.handle("orb:theme-get", () => themeSnapshot());

ipcMain.handle("orb:theme-set", (_event, mode) => {
  const saved = saveStoredTheme(mode);
  applyStoredTheme();
  pushAppearance();
  return Object.assign({ ok: true }, pushTheme(), { mode: saved });
});

ipcMain.handle("orb:bg-get", () => backgroundsSnapshot());

/**
 * 背景图选择框的起始目录（2026-10-20 用户要求）。
 *
 * 之前根本不传 defaultPath —— Electron 会退回它自己的记忆目录（往往是系统目录或
 * 上次用过的别处），对着一个空目录找图很别扭。现在：
 *   第一次（没存过）→ 项目根（orb 安装目录）；
 *   选过一次之后   → 记住那个文件所在的目录，下次直接落在那儿。
 * 落在 `logs/window-state.json` 的 `bgLastDir`，跟窗口尺寸/头像/透明度同一份文件。
 */
function loadBgLastDir() {
  const saved = readWindowState().bgLastDir;
  if (typeof saved !== "string" || saved === "") return PROJECT_ROOT;
  try {
    if (statSync(saved).isDirectory()) return saved;
  } catch {}
  // 目录被删/被挪走了：退回项目根，别让对话框开在一个不存在的路径上。
  return PROJECT_ROOT;
}

function saveBgLastDir(dir) {
  if (typeof dir !== "string" || dir === "") return;
  writeWindowState(Object.assign({}, readWindowState(), { bgLastDir: dir }));
}

ipcMain.handle("orb:bg-import", async (_event, slot) => {
  if (!BG_SLOTS.includes(slot)) return failBg(slot);
  const options = {
    title: "选择背景图片",
    properties: ["openFile"],
    filters: [{ name: "图片", extensions: BG_EXTS }],
    defaultPath: loadBgLastDir(),
  };
  const picked =
    win && !win.isDestroyed()
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options);
  if (picked.canceled || picked.filePaths.length === 0) return { ok: false, canceled: true };
  const source = picked.filePaths[0];
  // 记住这次挑的目录（挑完就落盘，下次打开对话框直接从这里开始）。
  saveBgLastDir(dirname(source));
  const ext = (source.split(".").pop() ?? "").toLowerCase();
  if (!BG_EXTS.includes(ext)) return { ok: false, error: "只支持 png / jpg / webp / gif" };
  let size = 0;
  try {
    size = statSync(source).size;
  } catch {
    return { ok: false, error: `读不到文件：${source}` };
  }
  if (size > BG_MAX_BYTES) return { ok: false, error: "图片超过 32 MB，换一张小点的" };
  // 每次导入换一个新文件名（带时间戳）⇒ 不必和 CSS/内存里的旧图斗缓存。
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "");
  const name = `bg-${slot}-${stamp}.${ext}`;
  try {
    mkdirSync(BG_DIR, { recursive: true });
    copyFileSync(source, join(BG_DIR, name));
  } catch (error) {
    return { ok: false, error: `复制图片失败：${error?.message ?? error}` };
  }
  const stored = loadStoredBackgrounds();
  stored[slot] = Object.assign({}, stored[slot], { file: name });
  saveStoredBackgrounds(stored);
  return Object.assign({ ok: true, slot, source }, pushBackgrounds());
});

ipcMain.handle("orb:bg-clear", (_event, slot) => {
  if (!BG_SLOTS.includes(slot)) return failBg(slot);
  const stored = loadStoredBackgrounds();
  // 只清记录，不动磁盘上的文件：用户换回来时还能直接挑回来。
  stored[slot] = Object.assign({}, stored[slot], { file: "" });
  saveStoredBackgrounds(stored);
  return Object.assign({ ok: true }, pushBackgrounds());
});

ipcMain.handle("orb:bg-update", (_event, patch) => {
  const input = patch && typeof patch === "object" ? patch : {};
  if (!BG_SLOTS.includes(input.slot)) return failBg(input.slot);
  const stored = loadStoredBackgrounds();
  const entry = stored[input.slot] ?? normalizeBgSlot(null);
  if (input.fit !== undefined) entry.fit = clampBgFit(input.fit);
  if (input.scrim !== undefined) entry.scrim = clampBgScrim(input.scrim);
  stored[input.slot] = entry;
  saveStoredBackgrounds(stored);
  return Object.assign({ ok: true }, pushBackgrounds());
});

ipcMain.on("orb:bg-open-folder", () => {
  try {
    mkdirSync(BG_DIR, { recursive: true });
  } catch {}
  void shell.openPath(BG_DIR);
});
//#endregion
export {  };
