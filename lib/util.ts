import connect from 'connect'
import serveStatic from 'serve-static'
import path from 'path'
import fs from 'fs'
import svelte from 'svelte'
import fetch from 'node-fetch'
import { camelCase } from 'lodash'

let iconCache: string | null = null

class Util {
  static serveWith404(dir: string) {
    return connect()
      .use(serveStatic(dir))
      .use((i, o) => {
        o.statusCode = 404
        o.end()
      })
  }

  static serveSvelte(req: any, res: any) {
    let name = path.basename(req.url, '.js')
    fs.readFile(
      path.join(__dirname, '../lib', name + '.html'),
      'utf8',
      function (err, data) {
        if (err) throw err
        name = name[0].toUpperCase() + name.slice(1)
        try {
          const { js } = svelte.compile(data, {
            format: 'iife',
            name: name,
            store: true,
          })
          const code = js.code.replace(`var ${name} =`, `Zen.${name} =`)
          res.writeHead(200, {
            'Content-Type': 'application/javascript; charset=utf-8',
          })
          res.end(code, 'utf8')
        } catch (e) {
          res.statusCode = 500
          console.error(e)
          res.end()
        }
      }
    )
  }

  static async serveIcons(req: any, res: any) {
    if (iconCache) return res.end(iconCache)
    const icons: Record<string, string> = {}
    const root = path.join(__dirname, '../assets')
    await Promise.all(
      fs.readdirSync(root).map(async (fname) => {
        if (!fname.match(/([\w_\-]+)\.svg$/)) return null
        // @ts-expect-error Unclear why this thinks its unknown.
        icons[camelCase(RegExp.$1)] = await Util.readFileAsync(
          path.join(root, fname)
        )
      })
    )

    iconCache = 'Zen.icons = ' + JSON.stringify(icons)
    res.end(iconCache)
  }

  static wsSend(ws: any, obj: any) {
    if (!ws || ws.readyState != WebSocket.OPEN) return
    ws.send(JSON.stringify(obj), (error) => {
      if (error) console.error('Websocket error', error)
    })
  }

  static async post(url: string, obj: any) {
    const resp = await fetch(url, { method: 'POST', body: JSON.stringify(obj) })
    const body = await resp.text()

    if (resp.status === 200) {
      return JSON.parse(body)
    } else {
      throw new Error(`Error on ${url}: ${resp.status} ${body}`)
    }
  }

  static readFile(p: string, encoding?: string) {
    if (encoding === undefined) encoding = 'utf8'
    Util.ensureDir(path.dirname(p))
    if (!fs.existsSync(p)) return ''
    // @ts-expect-error
    return fs.readFileSync(p, encoding)
  }

  static async readFileAsync(p: string, encoding?: string) {
    if (encoding === undefined) encoding = 'utf8'
    Util.ensureDir(path.dirname(p))
    return new Promise((res, rej) => {
      // @ts-expect-error
      fs.readFile(p, encoding, (err, data) => res(data))
    })
  }

  static async writeFile(p: string, data = '') {
    Util.ensureDir(path.dirname(p))
    return new Promise((res, rej) => {
      // @ts-expect-error
      fs.writeFile(p, data, (err) => res())
    })
  }

  static ensureDir(dir: string) {
    const parent = path.dirname(dir)
    fs.existsSync(parent) || Util.ensureDir(parent)
    fs.existsSync(dir) || fs.mkdirSync(dir)
  }

  static verboseLog(...args: any[]) {
    if (process.env.VERBOSE === 'true') {
      console.log(args)
    }
  }

  static last(arr: any[]): any {
    return arr[arr.length - 1]
  }
}

export default Util
