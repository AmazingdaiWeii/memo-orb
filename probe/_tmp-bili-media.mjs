import { createMediaResolver, fetchView, fetchPlayurl, pickReachableUrl } from '../src/bili-media.mjs'

const BV = process.argv[2] || 'BV1GJ411x7h7'
const log = (s) => console.log('LOG', s)

const view = await fetchView({ bvid: BV })
console.log('view', view.ok, view.bvid, view.cid, view.title, view.duration, 'pages=' + (view.pages?.length || 0))
const play = await fetchPlayurl({ bvid: view.bvid, cid: view.cid })
console.log('play', play.ok, play.dash, 'q=' + play.quality, play.qualityLabel, JSON.stringify(play.acceptQuality))
if (play.video) console.log('video', play.video.width, play.video.height, play.video.codec, 'backups=' + play.video.backupUrls.length)

const t0 = Date.now()
const reach = await pickReachableUrl(play.video, { log })
console.log('reach', reach.ok, reach.url ? reach.url.slice(0, 70) + '…' : reach.error, `${Date.now() - t0}ms`)

const media = createMediaResolver({ getCookie: () => '', log })
const url = await media.getMediaUrl({ aid: view.aid, cid: view.cid })
console.log('resolver', Boolean(url), url.slice(0, 70) + '…')

// Range 取头 64KB → 给 kfdecode.indexStream 用
const res = await fetch(url, {
  headers: {
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    referer: 'https://www.bilibili.com',
    range: 'bytes=0-65535',
  },
})
const buf = Buffer.from(await res.arrayBuffer())
console.log('range', res.status, buf.length, res.headers.get('content-range'))
const { indexStream } = await import('../src/kfdecode.mjs').catch(() => ({}))
console.log('kfdecode import', typeof indexStream)
