/*!
 * connect-multiparty
 * Copyright(c) 2010 Sencha Inc.
 * Copyright(c) 2011 TJ Holowaychuk
 * Copyright(c) 2013 Andrew Kelley
 * MIT Licensed
 */

'use strict'

/**
 * Module dependencies.
 * @private
 */

var createError = require('http-errors')
var multiparty = require('multiparty');
var onFinished = require('on-finished');
var qs = require('qs');
var typeis = require('type-is');

/**
 * Module exports.
 * @public
 */

module.exports = multipart

/**
 * Parse multipart/form-data request bodies, providing the parsed
 * object as `req.body` and `req.files`.
 *
 * The options passed are merged with [multiparty](https://github.com/pillarjs/multiparty)'s
 * `Form` object, allowing you to configure the upload directory,
 * size limits, etc. For example if you wish to change the upload
 * dir do the following:
 *
 *     app.use(multipart({ uploadDir: path }))
 *
 * ## Custom storage (pre-disk content validation)
 *
 * Pass `options.storage` to take over how each file part is persisted. The default
 * behavior (writing every part to `uploadDir` via multiparty's built-in handler) still
 * applies when `storage` is omitted, so this is fully backward-compatible.
 *
 *     app.use(multipart({
 *       uploadDir: '/tmp',
 *       storage: function (req, part, publicFile, cb) {
 *         // part: a multiparty Part (readable stream)
 *         // publicFile: pre-populated {fieldName, originalFilename, name, type, headers, size: 0}
 *         //             — the storage function should fill in publicFile.path and publicFile.size
 *         //             before calling cb().
 *         // cb(err) → on err the storage should destroy(part) for resource hygiene
 *         //          (stop reading the network) and call cb(err). connect-multiparty
 *         //          then drains the request and surfaces 400 via next(err); it is
 *         //          form.emit('error') that releases the parser, not destroying the
 *         //          part stream.
 *       }
 *     }))
 *
 * Typical implementations buffer the first few KB of `part`, run a magic-byte gate,
 * and either pipe the rest to disk (no fs.createWriteStream until validation passes)
 * or destroy(part) and call cb(err). This is the same StorageEngine model multer 1.x
 * exposes.
 *
 * ### Size limit caveat
 *
 * `options.maxFilesSize` (default 100 MB) is enforced by multiparty INSIDE its
 * built-in handleFile via a LimitStream. With `options.storage` set, multiparty
 * routes file parts to handlePart instead — no LimitStream is inserted. **When you
 * provide a storage engine, enforcing a per-request/per-file size cap becomes the
 * storage engine's responsibility** (e.g. via a multer-style `limits.fileSize` or
 * a counter inside the part 'data' handler). The middleware will not warn if the
 * cap is silently bypassed.
 *
 * @param {Object} options
 * @return {Function}
 * @public
 */

function multipart (options) {
  options = options || {};
  // Use default max size of 100 MB for all files combined, roughly matching the default
  // multipart request size limit of 100 MiB in Express 3 / connect@2.30.2:
  // https://github.com/senchalabs/connect/blob/2.30.2/lib/middleware/multipart.js#L86
  options.maxFilesSize = options.maxFilesSize || 100 * 1000 * 1000;

  var storage = options.storage;

  // When the caller provides a storage engine, we need multiparty to emit raw 'part'
  // events instead of running its built-in handleFile that opens a write stream and
  // pipes immediately. autoFields stays on so text fields still come through as
  // 'field' events.
  if (typeof storage === 'function') {
    options.autoFields = true;
    options.autoFiles = false;
  }

  return function multipart(req, res, next) {
    if (req._body) return next();
    req.body = req.body || {};
    req.files = req.files || {};

    // ignore GET
    if ('GET' === req.method || 'HEAD' === req.method) return next();

    // check Content-Type
    if (!typeis(req, 'multipart/form-data')) return next();

    // flag as parsed
    req._body = true;

    // parse
    var form = new multiparty.Form(options);
    var data = {};
    var files = {};
    var done = false;

    // Used by the storage path to keep the request open until every per-part storage
    // callback has resolved. multiparty's 'close' event fires when all part STREAMS
    // have ended, but our storage may still be flushing bytes to disk after that.
    var pendingStorage = 0;
    var partsClosed = false;

    function ondata(name, val, data){
      if (Array.isArray(data[name])) {
        data[name].push(val);
      } else if (data[name]) {
        data[name] = [data[name], val];
      } else {
        data[name] = val;
      }
    }

    function finishParse() {
      if (done) return;
      done = true;
      // expand names with qs & assign
      // Note: `allowDots: false, allowPrototypes: true` come from Express 3 / connect@2.30.2:
      // https://github.com/senchalabs/connect/blob/2.30.2/lib/middleware/multipart.js#L148-L149
      req.body = qs.parse(data, { allowDots: false, allowPrototypes: true })
      /**
       * Dictionary of field name to FileInfo
       * @type {{[fieldName: string]: FileInfo}}
       */
      req.files = qs.parse(files, { allowDots: false, allowPrototypes: true })

      next()
    }

    form.on('field', function(name, val){
      ondata(name, val, data);
    });

    if (typeof storage === 'function') {
      form.on('part', function(part) {
        // Drop any parts that arrive after the request has already finished (either
        // via an error from a previous part's storage callback, or after a successful
        // finishParse). Multiparty keeps parsing buffered parts even after we've
        // signaled completion to express; without this guard we'd kick off new
        // storage work whose results have nowhere to go.
        if (done) {
          part.resume();
          return;
        }

        var publicFile = {
          fieldName: part.name,
          originalFilename: part.filename,
          name: part.filename,
          type: part.headers['content-type'] || null,
          headers: part.headers,
          size: 0
          // `path` is left to the storage engine to fill in once it has chosen one
          // (typical engines randomize the filename to avoid collisions / traversal).
        };

        pendingStorage++;
        storage(req, part, publicFile, function (err) {
          pendingStorage--;
          if (err) {
            // The storage engine should destroy(part) for resource hygiene; it is
            // form.emit('error') below that actually releases the parser and drives
            // the 400 response.
            form.emit('error', err);
            return;
          }
          ondata(part.name, publicFile, files);
          if (partsClosed && pendingStorage === 0) finishParse();
        });
      });
    } else {
      form.on('file', function(name, val){
        val.name = val.originalFilename;
        val.type = val.headers['content-type'] || null;
        ondata(name, val, files);
      });
    }

    form.on('error', function(err){
      if (done) return;

      done = true;

      // set status code on error
      var error = createError(400, err)

      if (!req.readable) return next(error)

      // read off entire request
      req.resume();
      onFinished(req, function(){
        next(error)
      });
    });

    form.on('close', function() {
      if (done) return;
      partsClosed = true;
      // With a custom storage engine, wait for any in-flight per-part callbacks to
      // resolve before finalizing — multiparty's 'close' fires on part-stream end,
      // not on write-stream finish.
      if (pendingStorage === 0) finishParse();
    });

    form.parse(req);
  }
};

/**
 * @typedef {object} FileInfo - Uploaded file from a multipart form
 *
 * @property {string} name - original filename, from user's system
 * @property {string} originalFilename - original filename, from user's system
 * @property {string} type - content-type of the file, from user's browser
 * @property {number} size - size of the file in bytes
 * @property {string} path - local filesystem path to uploaded file
 * @property {string} fieldName - name of the form field
 */
