'use strict'

const async = require('async')
const AWS = require('aws-sdk')
const webfontsGenerator = require('webfonts-generator')
const fs = require('fs')
const util = require('util')
const path = require('path')

// get reference to S3 client
const s3 = new AWS.S3()

// Generate Codepoint hashes
function hashCode (str) { // java String#hashCode
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash)
  }
  return hash
}

function intToRGB (i) {
  const c = (i & 0x00FFFFFF)
    .toString(16)
    .toUpperCase()

  return '00000'.substring(0, 6 - c.length) + c
}

module.exports.generateWebfont = (event, context, callback) => {
  // Read options from the event.
  console.log('Reading options from event:\n', util.inspect(event, { depth: 5 }))
  // Object key may have spaces or unicode non-ASCII characters.
  const srcKey = decodeURIComponent(event.Records[0].s3.object.key.replace(/\+/g, ' '))

  // Infer the image type.
  const typeMatch = srcKey.match(/\.([^.]*)$/)
  if (!typeMatch) {
    console.error('unable to infer image type for key ' + srcKey)
    return
  }
  const imageType = typeMatch[1]
  if (imageType !== 'svg') {
    console.log('skipping non-svg ' + srcKey)
    return
  }

  // Prepare webfont settings
  const dir = path.dirname(srcKey)
  const name = dir.split(path.sep).slice(-1).pop()
  const webfontOptions = {
    filename: srcKey,
    bucket: event.Records[0].s3.bucket.name,
    output: '/tmp/',
    source: '/tmp/',
    name: name,
    path: name
  }
  console.log('Generating webfont:\n', util.inspect(webfontOptions, { depth: 5 }))

  // Validate webfont options
  if (!webfontOptions.name) {
    console.log('No folder name specified ' + srcKey)
    return
  }

  // Download all SVGs from S3, generate webfont files, and upload to S3 bucket.
  async.waterfall([
    /**
             * Download all SVG files of that folder
             * @param next
             */
    function download (next) {
      const payload = {}
      payload.files = []
      payload.jsonMap = null

      // Read all files of the S3 folder the file has been uploaded to
      s3.listObjects({
        Bucket: webfontOptions.bucket,
        Prefix: dir
      }, function (err, data) {
        // GET objects in parallel
        async.each(data.Contents, function (file, callback) {
          // Prepare file information for writing
          const fileName = path.basename(file.Key)
          const fileExt = path.extname(file.Key)
          if (fileExt !== '.svg' && fileName !== `${webfontOptions.name}.json`) {
            console.log(`Not an SVG file ${file.Key}`)
            callback()
            return
          }

          // Download each item to the local tmp folder
          console.log(`Downloading ${file.Key}`)
          s3.getObject({
            Bucket: webfontOptions.bucket,
            Key: file.Key
          }, function (err, data) {
            if (err) {
              console.error(err.code, '-', err.message)
              callback()
              return
            }

            // Write file to disk
            fs.writeFile(`/tmp/${fileName}`, data.Body, function (err) {
              if (err) {
                console.log(err.code, '-', err.message)
              }

              if (fileName === `${webfontOptions.name}.json`) {
                console.log(`JSON map detected: ${webfontOptions.name}.json`)
                payload.jsonMap = `${webfontOptions.name}.json`
              } else {
                payload.files.push(`/tmp/${fileName}`)
              }
              callback()
            })
          })
        }, function (err) {
          if (err) {
            console.log(err)
            return
          }

          // All files are available in /tmp/ folder now
          console.log(
                            `${payload.files.length} SVG files downloaded from '${webfontOptions.bucket}/${dir}/' to '/tmp/'\n`)
          next(null, payload)
        })
      })
    },
    /**
             * Generate webfont
             * @param payload
             * @param next
             */
    function generateFont (payload, next) {
      // Generate codepoints from existing JSON map
      let jsonMap = {}
      if (payload.jsonMap) {
        let jsonContent = fs.readFileSync(`/tmp/${payload.jsonMap}`, 'utf8')
        console.log(`Read JsonMap string from /tmp/${payload.jsonMap}:\n`, util.inspect(jsonContent, { depth: 5 }))
        jsonContent = jsonContent.replace(/\\/g, '')
        console.log(`Unescaped JsonMap string from /tmp/${payload.jsonMap}:\n`, util.inspect(jsonContent, { depth: 5 }))
        jsonMap = JSON.parse(jsonContent)

        // Add a single \ to each value. Remove keys which are not in the filelist
        const filelist = payload.files.map(file => file.substr(5, file.length - 9))
        console.log('Filelist array:\n', util.inspect(jsonContent, { depth: 5 }))
        for (const key of Object.keys(jsonMap)) {
          jsonMap[key] = parseInt(`0x${jsonMap[key]}`, 16)
          const iconAvailable = filelist.find(file => file === key)
          if (!iconAvailable) {
            console.log(`Delete ${key} from jsonMap. File is not available any more.`)
            delete jsonMap[key]
          }
        }
        console.log('JsonMap object:\n', util.inspect(jsonMap, { depth: 5 }))
      }

      // @see https://www.npmjs.com/package/webfonts-generator
      const config = {
        baseTag: 'i',
        baseSelector: '.icon',
        classPrefix: 'icon-',
        codepoints: jsonMap,
        // cssDest    : '/tmp/',
        // cssFontsUrl     : options.fontsPath,
        cssTemplate: 'templates/css.hbs',
        // types      : ['eot', 'woff2', 'woff', 'ttf', 'svg']
        centerHorizontally: true,
        css: true,
        decent: 150,
        dest: '/tmp/',
        files: payload.files,
        fixedWidth: true, // Creates a monospace font of the width of the largest input icon.
        fontHeight: 1000,
        fontName: webfontOptions.name,
        html: true,
        // htmlDest          : '/tmp/',
        htmlTemplate: 'templates/html.hbs',
        json: true,
        normalize: true,
        round: 10e12,
        templateOptions: {
          bucket: `https://${webfontOptions.bucket}.s3.amazonaws.com/${webfontOptions.name}/`
        }
      }
      console.log('\nStart generating webfont:\n', util.inspect(config, { depth: 5 }))
      webfontsGenerator(config, function (error, result) {
        if (error) {
          console.log('An error occured, while generating the webfont.', error)
          next(error)
        } else {
          console.log('Successfully generated webfont files.\n')
          fs.readdirSync('/tmp/').forEach(file => {
            const fileExt = path.extname(file)
            if (['.eot', '.woff2', '.woff', '.ttf', '.css', '.html', '.scss', '.json'].indexOf(
              fileExt) > -1) {
              console.log(`/tmp/${file}`)
            }
          })

          // If specified, generate JSON icons map by parsing the generated CSS
          if (config.json) {
            const jsonPath = `/tmp/${config.fontName}.json`
            console.log(`Generate JSON map ${jsonPath}.\n`)
            const map = {}
            const css = result.generateCss()
            const CSS_PARSE_REGEX = /\-(.*)\:before.*\n\s*content: "(.*)"/gm
            css.replace(CSS_PARSE_REGEX, (match, name, code) => {
              map[name] = code
            })

            fs.writeFile(jsonPath, JSON.stringify(map, null, 4), next)
          } else {
            next()
          }
        }
      })
    },
    /**
             * Upload webfont to S3
             * @param next
             */
    function upload (next) {
      const payload = {}
      payload.files = []

      // Stream the transformed image to a different S3 bucket.
      console.log('Start uploading font files')

      // Get all files from /tmp/ folder and upload them to S3 if it is a webfont file
      const files = fs.readdirSync('/tmp/')
      async.each(files, function (file, callback) {
        const fileExt = path.extname(file)

        if (['.eot', '.woff2', '.woff', '.ttf', '.css', '.html', '.scss', '.json'].indexOf(
          fileExt) > -1) {
          fs.readFile(`/tmp/${file}`, function (err, data) {
            console.log(`Start uploading ${file}`)
            if (err) {
              console.log(`An error occured while reading ${file}`)
              callback()
              return
            }

            // Get the correct content type for the current file
            let contentType = 'text/plain'
            switch (fileExt) {
              case '.eot':
                contentType = 'application/vnd.ms-fontobject'
                break
              case '.woff2':
                contentType = 'font/woff2'
                break
              case '.woff':
                contentType = 'application/font-woff'
                break
              case '.ttf':
                contentType = 'application/font-sfnt'
                break
              case '.css':
                contentType = 'text/css'
                break
              case '.html':
                contentType = 'text/html'
                break
              case '.scss':
                contentType = 'text/x-scss'
                break
              case '.json':
                contentType = 'application/json'
                break
            }

            // Buffer Pattern; how to handle buffers; straw, intake/outtake analogy
            const base64data = new Buffer(data, 'binary')
            s3.putObject({
              Bucket: webfontOptions.bucket,
              Key: `${dir}/${file}`,
              Body: base64data,
              ContentType: contentType
            }, function (err, data) {
              if (err) {
                console.error(err.code, '-', err.message)
                callback()
                return
              }

              console.log(data)
              payload.files.push(`s3://${webfontOptions.bucket}/${dir}/${file}`)
              console.log(`File uploaded to s3://${webfontOptions.bucket}/${dir}/${file}`)
              callback()
            })
          })
        } else {
          if (fileExt !== '.svg') {
            console.log(`Skip ${file}, it's not a webfont file.`)
          }
          callback()
        }
      }, function (err) {
        if (err) {
          console.log(err)
          return
        }

        // All tasks are done now
        console.log(
                        `${payload.files.length} webfont files uploaded to '${webfontOptions.bucket}/${dir}/\n`)

        // Cleanup
        console.log('Delete all files in /tmp/ folder.')
        const directory = '/tmp/'

        fs.readdir(directory, (err, files) => {
          if (err) throw err

          for (const file of files) {
            fs.unlink(path.join(directory, file), err => {
              if (err) throw err
            })
          }

          next(null, payload)
        })
      })
    },
    /**
             * Cleanup Lambda environment
             * @param next
             */
    function cleanup (next) {

    }
  ],

  function (err) {
    if (err) {
      console.error('An error occured while generating the webfont')
      context.done(err, 'An error occured')
      return
    }

    console.log('Finished generating web font')
    context.done(err, 'Finished generating web font')
  }
  )

  const response = {
    statusCode: 200,
    body: JSON.stringify({
      message: 'Go Serverless v1.0! Your function executed successfully!',
      input: event
    })
  }

  callback(null, response)
}
