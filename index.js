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

    function ondata(name, val, data){
      if (Array.isArray(data[name])) {
        data[name].push(val);
      } else if (data[name]) {
        data[name] = [data[name], val];
      } else {
        data[name] = val;
      }
    }

    form.on('field', function(name, val){
      ondata(name, val, data);
    });

    form.on('file', function(name, val){
      val.name = val.originalFilename;
      val.type = val.headers['content-type'] || null;
      ondata(name, val, files);
    });

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
