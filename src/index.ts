import qiniu from 'qiniu'
import globby from 'globby'
import type { PluginOption } from 'vite'
import _ from 'lodash'

export interface Options {
  accessKey: string
  secretKey: string
  bucket: string
  include?: RegExp
  /** 七牛云区域 */
  zone?: string
  /** 并发数 */
  concurrent?: number
  /** key 前缀 */
  prefix?: string
  /** 打包文件目录 */
  distDir?: string
  /** 是否输出日志 */
  log?: boolean
  hostname?: string
}

enum StatusCode {
  Success = 200,
  /** 指定资源不存在或已被删除 */
  NoFound = 612,
  /** 资源已经存在 */
  Exist = 614,
  /** 已创建的空间数量达到上限，无法创建新空间 */
  ExceededLimit = 630,
  /** 指定空间不存在 */
  NoFoundSite = 631,
  /** 可能是因为 DNS 解析错误，无法正确的访问存储桶地址 */
  NetWorkError = -1,
}

function print(isPrint: boolean) {
  return function (message: any) {
    if (isPrint) {
      console.log('qiniu plugin log = ', message)
    }
  }
}

function getMimeType(fileName: string) {
  switch(fileName.slice(-3)) {
    case 'css':
      return 'text/css';
    case '.js':
      return 'text/javascript';
  }
}

export default function qiniuPlugin(options: Options): PluginOption {
  // NOTE: 覆盖上传 index.html 并刷新缓存，前提已上传其他静态文件
  const {
    accessKey,
    secretKey,
    bucket,
    include = /(index.html)$/,
    zone = 'z0',
    concurrent = 10,
    prefix = '',
    distDir = 'dist',
    log = true,
  } = options
  const mac = new qiniu.auth.digest.Mac(accessKey, secretKey)
  const putPolicy = new qiniu.rs.PutPolicy({ scope: `${bucket}:index.html` })
  const uploadToken = putPolicy.uploadToken(mac)
  const config = new qiniu.conf.Config()
  const cdnManager = new qiniu.cdn.CdnManager(mac);

  // @ts-ignore
  config.zone = qiniu.zone[zone]
  const formUploader = new qiniu.form_up.FormUploader(config)
  const putExtra = new qiniu.form_up.PutExtra()

  const logger = print(log)

  return {
    name: 'vite-plugin-qiniu-upload-html',
    async writeBundle() {
      const files = await globby([`${distDir}/**/*`])
      const chunkedFiles = _.chunk(files, concurrent)
      await Promise.all(
        chunkedFiles.map((chunk) => {
          return new Promise((resolve, reject) => {
            const promises = chunk.map((file) => {
              if (!include.test(file)) {
                logger(`文件被排除${file}`)
                return Promise.resolve()
              }
              const dirPath = file.replace('dist/', '')
              let preStr = prefix || 'upqn-prefix/'

              if (!preStr.endsWith('/')) {
                preStr += '/'
              }
              if (preStr.startsWith('/')) {
                preStr = preStr.substring(1, preStr.length)
              }

              const remotePath = preStr + dirPath

              return new Promise((resolve, reject) => {
                formUploader.putFile(
                  uploadToken,
                  remotePath,
                  file,
                  {
                    ...putExtra,
                    mimeType: getMimeType(file)
                  },
                  function (respErr, respBody, respInfo) {
                    if (respErr) {
                      reject(respErr)
                    }

                    logger(respInfo)

                    switch (respInfo?.statusCode) {
                      case StatusCode.Success:
                        logger(`上传成功${dirPath}`)
                        resolve(respBody)
                        break
                      case StatusCode.Exist:
                        logger(`文件已存在${dirPath}`)
                        resolve(respBody)
                        break
                      case StatusCode.NetWorkError:
                        reject('DNS 解析错误，无法正确访问存储桶地址')
                        break
                      default:
                        reject(respBody)
                    }
                  }
                )
              })
            })
            Promise.all(promises)
              .then((res) => {
                logger(`上传成功${res.length}个文件`)
                const indexHtmlUrl = `http://${hostname}/${res.data.key}`
                cdnManager.refreshUrls([indexHtmlUrl], (err, respBody, respInfo) => {
                  if (err) {
                    logger(err)
                    throw err
                  }
                  if (respInfo.statusCode == 200) {
                    logger(respInfo)
                    resolve(res)
                  } else {
                    throw respInfo
                  }
                })
              })
              .catch((err) => {
                reject(err)
              })
          })
        })
      )
    },
  }
}
