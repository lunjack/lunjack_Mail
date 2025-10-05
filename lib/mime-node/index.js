/* eslint no-undefined: 0, prefer-spread: 0, no-control-regex: 0 */

'use strict';

// 引入必要的模块
const fs = require('fs');
const { PassThrough } = require('stream');
const { randomBytes } = require('crypto');

// 引入自定义模块
const { QpEncoder } = require('../qp');
const { Base64Encoder } = require('../base64');
const nmfetch = require('../fetch');
const { regexs, resetRegex } = require('../regexs');
const addressparser = require('../addressparser');
const { callbackPromise } = require('../shared');
const { toASCII } = require('../punycode');
const {
    detectMimeType, isPlainText, hasLongerLines, foldLines, parseHeaderValue, buildHeaderValue, encodeWord, encodeWords
} = require('../mime-funcs');

// 引入换行符处理模块
const LeWindows = require('./le-windows');
const LeUnix = require('./le-unix');
const LastNewline = require('./last-newline');

/**
 * 创建一个新的MIME树节点。如果是分支节点，假设内容类型为'multipart/*'，
 * 其他任何内容类型都视为叶节点。如果选项中缺少rootNode，则假设此为根节点。
 *
 * @param {String} contentType 定义节点的内容类型。对于附件可以留空（从文件名派生）
 * @param {Object} [options] 可选选项
 * @param {Object} [options.rootNode] 此树的根节点
 * @param {Object} [options.parentNode] 此节点的直接父节点
 * @param {Object} [options.filename] 附件节点的文件名
 * @param {String} [options.baseBoundary] 唯一多部分边界值的共享部分
 * @param {Boolean} [options.keepBcc] 如果为true，不在生成的头部中排除Bcc
 * @param {Function} [options.normalizeHeaderKey] 用于自定义头部键大小写规范化的方法
 * @param {String} [options.textEncoding] 编码类型：'Q'（默认）或'B'
 */
class MimeNode {
    constructor(contentType, options = {}) {
        this.nodeCounter = 0;

        // 唯一多部分边界值的共享部分
        this.baseBoundary = options.baseBoundary || randomBytes(8).toString('hex');
        this.boundaryPrefix = options.boundaryPrefix || '--_NmP';
        this.disableFileAccess = !!options.disableFileAccess;
        this.disableUrlAccess = !!options.disableUrlAccess;
        this.normalizeHeaderKey = options.normalizeHeaderKey;
        this.date = new Date();                                 // 当前日期
        this.rootNode = options.rootNode || this;               // 当前MIME树的根节点
        this.keepBcc = !!options.keepBcc;                       // Bcc默认不保留

        // 如果指定了文件名但未指定内容类型(可能是附件, 则从文件扩展名检测内容类型)
        if (options.filename) {
            this.filename = options.filename;
            if (!contentType) contentType = detectMimeType(this.filename.split('.').pop());
        }

        // 指示头部字符串应使用的编码："Q"或"B"
        this.textEncoding = (options.textEncoding || '').toString().trim().charAt(0).toUpperCase();
        this.parentNode = options.parentNode;                   // 此节点的直接父节点（如果未设置则为undefined）
        this.hostname = options.hostname;                       // 默认message - id值使用的主机名

        // 如果设置为'win'则使用\r\n，如果为'linux'则使用\n; 如果未设置（或使用`raw`），则换行符保持原样
        this.newline = options.newline;
        this.childNodes = [];                                   // 可能的子节点数组
        this._nodeId = ++this.rootNode.nodeCounter;             // 用于生成唯一边界值（前缀添加到共享基础值之前）
        this._headers = [];                                     // 此节点的头部值列表，格式为[{ key: '', value: '' }]
        this._isPlainText = false;                              // 如果内容仅使用ASCII可打印字符则为true
        this._hasLongLines = false;                             // 如果内容是纯文本但有超过允许长度的行则为true
        this._envelope = false;                                 // 如果设置，则使用此值作为信封而不是生成一个
        this._raw = false;                                      // 如果设置，则使用此值作为流内容而不是构建它
        this._transforms = [];                                  // 在通过createReadStream暴露之前，消息将被管道传输的额外转换流
        this._processFuncs = [];                                // 在通过createReadStream暴露之前，消息将被管道传输的额外处理函数

        // 如果设置了内容类型（或从文件名派生），则将其添加到头部
        if (contentType) this.setHeader('Content-Type', contentType);
    }

    /**
     * 创建并附加一个子节点。提供的参数传递给MimeNode构造函数
     *
     * @param {String} [contentType] 可选内容类型
     * @param {Object} [options] 可选选项对象
     * @return {Object} 创建的节点对象
     */
    createChild(contentType, options) {
        if (!options && typeof contentType === 'object') {
            options = contentType;
            contentType = undefined;
        }
        let node = new MimeNode(contentType, options);
        this.appendChild(node);
        return node;
    }

    /**
     * 将现有节点附加到MIME树。如果需要，从现有树中移除该节点
     *
     * @param {Object} childNode 要附加的节点
     * @return {Object} 附加的节点对象
     */
    appendChild(childNode) {
        if (childNode.rootNode !== this.rootNode) {
            childNode.rootNode = this.rootNode;
            childNode._nodeId = ++this.rootNode.nodeCounter;
        }

        childNode.parentNode = this;
        this.childNodes.push(childNode);
        return childNode;
    }

    /**
     * 用另一个节点替换当前节点
     *
     * @param {Object} node 替换节点
     * @return {Object} 替换节点
     */
    replace(node) {
        if (node === this) return this;

        this.parentNode.childNodes.forEach((childNode, i) => {
            if (childNode === this) {
                node.rootNode = this.rootNode;
                node.parentNode = this.parentNode;
                node._nodeId = this._nodeId;

                this.rootNode = this;
                this.parentNode = undefined;

                node.parentNode.childNodes[i] = node;
            }
        });

        return node;
    }

    /**
     * 从MIME树中移除当前节点
     *
     * @return {Object} 被移除的节点
     */
    remove() {
        if (!this.parentNode) return this;

        for (let i = this.parentNode.childNodes.length - 1; i >= 0; i--) {
            if (this.parentNode.childNodes[i] === this) {
                this.parentNode.childNodes.splice(i, 1);
                this.parentNode = undefined;
                this.rootNode = this;
                return this;
            }
        }
    }

    /**
     * 设置头部值。如果选定键的值已存在，则会被覆盖。
     * 您也可以使用[{key:'', value:''}]或{key: 'value'}作为第一个参数来设置多个值。
     *
     * @param {String|Array|Object} key 头部键或键值对列表
     * @param {String} value 头部值
     * @return {Object} 当前节点
     */
    setHeader(key, value) {
        let added = false,
            headerValue;

        // 允许一次设置多个头部
        if (!value && key && typeof key === 'object') {
            // 允许 {key:'content-type', value: 'text/plain'}
            if (key.key && 'value' in key) this.setHeader(key.key, key.value);
            // 允许 [{key:'content-type', value: 'text/plain'}]
            else if (Array.isArray(key))
                key.forEach(i => {
                    this.setHeader(i.key, i.value);
                });
            // 允许 {'content-type': 'text/plain'}
            else
                Object.keys(key).forEach(i => {
                    this.setHeader(i, key[i]);
                });

            return this;
        }

        key = this._normalizeHeaderKey(key);

        headerValue = {
            key,
            value
        };

        // 检查值是否存在并覆盖
        for (let i = 0, len = this._headers.length; i < len; i++) {
            if (this._headers[i].key === key) {
                if (!added) {
                    // 替换第一个匹配项
                    this._headers[i] = headerValue;
                    added = true;
                } else {
                    // 移除后续匹配项
                    this._headers.splice(i, 1);
                    i--;
                    len--;
                }
            }
        }

        // 未找到匹配，追加值
        if (!added) this._headers.push(headerValue);

        return this;
    }

    /**
     * 添加头部值。如果选定键的值已存在，则值将作为新字段附加，旧字段不被触动。
     * 您也可以使用[{key:'', value:''}]或{key: 'value'}作为第一个参数来设置多个值。
     *
     * @param {String|Array|Object} key 头部键或键值对列表
     * @param {String} value 头部值
     * @return {Object} 当前节点
     */
    addHeader(key, value) {
        // 允许一次设置多个头部
        if (!value && key && typeof key === 'object') {
            // 允许 {key:'content-type', value: 'text/plain'}
            if (key && 'key' in key && 'value' in key) this.addHeader(key.key, key.value);
            // 允许 [{key:'content-type', value: 'text/plain'}]
            else if (Array.isArray(key))
                key.forEach(i => {
                    this.addHeader(i.key, i.value);
                });
            // 允许 {'content-type': 'text/plain'}
            else
                Object.keys(key).forEach(i => {
                    this.addHeader(i, key[i]);
                });

            return this;
        }
        // 否则，如果值是数组，则将每个值添加为新字段
        else if (Array.isArray(value)) {
            value.forEach(val => {
                this.addHeader(key, val);
            });
            return this;
        }

        this._headers.push({
            key: this._normalizeHeaderKey(key),
            value
        });

        return this;
    }

    /**
     * 检索选定键的第一个匹配值
     *
     * @param {String} key 要搜索的键
     * @retun {String} 键的值
     */
    getHeader(key) {
        key = this._normalizeHeaderKey(key);
        for (let i = 0, len = this._headers.length; i < len; i++) {
            if (this._headers[i].key === key) return this._headers[i].value;
        }
    }

    /**
     * 设置当前节点的正文内容。如果值是字符串，则自动将字符集添加到Content-Type（如果是text/*）。
     * 如果值是Buffer，则需要自行指定字符集
     *
     * @param (String|Buffer) content 正文内容
     * @return {Object} 当前节点
     */
    setContent(content) {
        this.content = content;
        if (typeof this.content.pipe === 'function') {
            // 预流处理程序。如果流被设置为内容，并且在此流执行任何操作之前触发'error'，则可能被触发
            this._contentErrorHandler = err => {
                this.content.removeListener('error', this._contentErrorHandler);
                this.content = err;
            };
            this.content.once('error', this._contentErrorHandler);
        } else if (typeof this.content === 'string') {
            this._isPlainText = isPlainText(this.content);
            // 如果有超过76个符号/字节的行，则不使用7bit编码，而是使用8位编码。
            if (this._isPlainText && hasLongerLines(this.content, 76)) this._hasLongLines = true;
        }
        return this;
    }

    // 构建MIME树
    build(callback) {
        let promise;

        if (!callback)
            // 如果没有回调，则返回一个承诺，该承诺将在构建完成时解析
            promise = new Promise((resolve, reject) => {
                callback = callbackPromise(resolve, reject);
            });

        let stream = this.createReadStream();
        let buf = [];
        let buflen = 0;
        let returned = false;

        stream.on('readable', () => {
            let chunk;

            while ((chunk = stream.read()) !== null) {
                buf.push(chunk);
                buflen += chunk.length;
            }
        });

        stream.once('error', err => {
            if (returned) return;
            returned = true;

            return callback(err);
        });

        stream.once('end', chunk => {
            if (returned) return;
            returned = true;
            // 如果流没有返回任何内容，则返回空缓冲区
            if (chunk && chunk.length) {
                buf.push(chunk);
                buflen += chunk.length;
            }
            return callback(null, Buffer.concat(buf, buflen));
        });

        return promise;
    }

    getTransferEncoding() {
        let transferEncoding = false;
        let contentType = (this.getHeader('Content-Type') || '').toString().toLowerCase().trim();

        if (this.content) {
            transferEncoding = (this.getHeader('Content-Transfer-Encoding') || '').toString().toLowerCase().trim();
            if (!transferEncoding || !['base64', 'quoted-printable'].includes(transferEncoding)) {
                if (regexs.TEXT_TYPE.test(contentType)) {
                    // 如果没有特殊符号，则无需修改文本
                    if (this._isPlainText && !this._hasLongLines) transferEncoding = '7bit';
                    // 否则，如果内容是字符串或Buffer，则使用QP或Base64
                    else if (typeof this.content === 'string' || this.content instanceof Buffer)
                        transferEncoding = this._getTextEncoding(this.content) === 'Q' ? 'quoted-printable' : 'base64';
                    // 否则,如果对于流，我们无法检查内容，因此使用首选编码或回退到QP
                    else transferEncoding = this.textEncoding === 'B' ? 'base64' : 'quoted-printable';
                }
                // 否则,如果不是 multipart 或 message 类型，默认使用 base64 编码
                else if (!regexs.MULTIPART_OR_MESSAGE.test(contentType)) transferEncoding = transferEncoding || 'base64';
            }
        }
        return transferEncoding;
    }

    /**
     * 构建MIME节点的头部块。在写入内容之前追加 \r\n\r\n
     *
     * @returns {String} 头部
     */
    buildHeaders() {
        let transferEncoding = this.getTransferEncoding();
        let headers = [];

        if (transferEncoding) this.setHeader('Content-Transfer-Encoding', transferEncoding);

        if (this.filename && !this.getHeader('Content-Disposition')) this.setHeader('Content-Disposition', 'attachment');

        // 确保必需的头部字段
        if (this.rootNode === this) {
            if (!this.getHeader('Date')) this.setHeader('Date', this.date.toUTCString().replace(/GMT/, '+0000'));

            // 确保Message-Id存在
            this.messageId();

            if (!this.getHeader('MIME-Version')) this.setHeader('MIME-Version', '1.0');

            // 确保根节点的Content-Type是最后一个头部
            for (let i = this._headers.length - 2; i >= 0; i--) {
                let header = this._headers[i];
                if (header.key === 'Content-Type') {
                    this._headers.splice(i, 1);
                    this._headers.push(header);
                }
            }
        }

        this._headers.forEach(header => {
            let key = header.key;
            let value = header.value;
            let structured;
            let param;
            let options = {};
            let formattedHeaders = ['From', 'Sender', 'To', 'Cc', 'Bcc', 'Reply-To', 'Date', 'References'];

            if (value && typeof value === 'object' && !formattedHeaders.includes(key)) {
                Object.keys(value).forEach(key => {
                    if (key !== 'value') options[key] = value[key];
                });
                value = (value.value || '').toString();
                if (!value.trim()) return;
            }

            if (options.prepared) {
                // 头部值已准备就绪
                if (options.foldLines) headers.push(foldLines(key + ': ' + value));
                else headers.push(key + ': ' + value);
                return;
            }

            switch (header.key) {
                case 'Content-Disposition':
                    structured = parseHeaderValue(value);
                    if (this.filename) structured.params.filename = this.filename;

                    value = buildHeaderValue(structured);
                    break;
                case 'Content-Type':
                    structured = parseHeaderValue(value);

                    this._handleContentType(structured);

                    if (regexs.TEXT_PLAIN.test(structured.value) && typeof this.content === 'string' && regexs.NON_ASCII.test(this.content))
                        structured.params.charset = 'utf-8';

                    value = buildHeaderValue(structured);

                    if (this.filename) {
                        // 为非兼容客户端（如QQ网页邮件）添加支持,我们不能使用buildHeaderValue构建值，因为该值是非标准的，并且不支持参数。
                        param = this._encodeWords(this.filename);
                        // 如果参数与文件名匹配，则不添加参数。如果参数包含特殊字符，则添加引号。
                        if (param !== this.filename || regexs.UNSAFE_PARAM_VALUE.test(param)) param = '"' + param + '"';

                        value += '; name=' + param;
                    }
                    break;

                case 'Bcc':
                    if (!this.keepBcc) return; // 如果不保留Bcc，则不添加头部
                    break; // 跳过BCC值
            }

            value = this._encodeHeaderValue(key, value);

            // 跳过空行
            if (!(value || '').toString().trim()) return;
            // 如果存在自定义的normalizeHeaderKey函数，则使用它来规范化头部键
            if (typeof this.normalizeHeaderKey === 'function') {
                let normalized = this.normalizeHeaderKey(key, value);
                if (normalized && typeof normalized === 'string' && normalized.length) key = normalized;
            }

            headers.push(foldLines(key + ': ' + value, 76));
        });

        return headers.join('\r\n');
    }

    /**
     * 从当前节点流式传输rfc2822消息。如果这是根节点，
     * 则设置缺失的必需头部字段（Date, Message-Id, MIME-Version）
     *
     * @return {String} 编译后的消息
     */
    createReadStream(options) {
        options = options || {};

        let stream = new PassThrough(options);
        let outputStream = stream;
        let transform;

        this.stream(stream, options, err => {
            if (err) {
                outputStream.emit('error', err);
                return;
            }
            stream.end();
        });

        for (let i = 0, len = this._transforms.length; i < len; i++) {
            transform = typeof this._transforms[i] === 'function' ? this._transforms[i]() : this._transforms[i];
            outputStream.once('error', err => {
                transform.emit('error', err);
            });
            outputStream = outputStream.pipe(transform);
        }

        // 在可能的用户转换之后确保终止换行符
        transform = new LastNewline();
        outputStream.once('error', err => {
            transform.emit('error', err);
        });
        outputStream = outputStream.pipe(transform);

        // 循环遍历所有后处理函数，并将输出流传递给每个函数。
        for (let i = 0, len = this._processFuncs.length; i < len; i++) {
            transform = this._processFuncs[i];
            outputStream = transform(outputStream);
        }

        if (this.newline) {
            const winbreak = ['win', 'windows', 'dos', '\r\n'].includes(this.newline.toString().toLowerCase());
            const newlineTransform = winbreak ? new LeWindows() : new LeUnix();

            const stream = outputStream.pipe(newlineTransform);
            outputStream.on('error', err => stream.emit('error', err));
            return stream;
        }

        return outputStream;
    }

    /**
     * 将转换流对象附加到转换列表。最终输出在暴露之前通过此流传递
     *
     * @param {Object} transform 读写流
     */
    transform(transform) {
        this._transforms.push(transform);
    }

    /**
     * 附加后处理函数。该函数在转换之后运行，并使用以下语法
     *
     *   processFunc(input) -> outputStream
     *
     * @param {Object} processFunc 读写流
     */
    processFunc(processFunc) {
        this._processFuncs.push(processFunc);
    }

    stream(outputStream, options, done) {
        let transferEncoding = this.getTransferEncoding();
        let contentStream;
        let localStream;

        // 保护实际回调防止多次触发
        let returned = false;
        let callback = err => {
            if (returned) return;
            returned = true;
            done(err);
        };

        // 对于多部分节点，推送子节点;对于内容节点，结束流
        let finalize = () => {
            let childId = 0;
            let processChildNode = () => {
                if (childId >= this.childNodes.length) {
                    outputStream.write('\r\n--' + this.boundary + '--\r\n');
                    return callback();
                }
                let child = this.childNodes[childId++];
                outputStream.write((childId > 1 ? '\r\n' : '') + '--' + this.boundary + '\r\n');
                child.stream(outputStream, options, err => {
                    if (err) return callback(err);
                    setImmediate(processChildNode);
                });
            };

            if (this.multipart) setImmediate(processChildNode);
            else return callback();
        };

        // 推送节点内容
        let sendContent = () => {
            if (this.content) {
                // 如果内容是错误，则直接调用回调
                if (Object.prototype.toString.call(this.content) === '[object Error]') return callback(this.content);

                if (typeof this.content.pipe === 'function') {
                    this.content.removeListener('error', this._contentErrorHandler);
                    this._contentErrorHandler = err => callback(err);
                    this.content.once('error', this._contentErrorHandler);
                }

                let createStream = () => {
                    if (['quoted-printable', 'base64'].includes(transferEncoding)) {
                        contentStream = new (transferEncoding === 'base64' ? Base64Encoder : QpEncoder)(options);
                        contentStream.pipe(outputStream, {
                            end: false
                        });
                        contentStream.once('end', finalize);
                        contentStream.once('error', err => callback(err));

                        localStream = this._getStream(this.content);
                        localStream.pipe(contentStream);
                    } else {
                        // 任何不是QP或Base54的内容都按原样传递
                        localStream = this._getStream(this.content);
                        localStream.pipe(outputStream, {
                            end: false
                        });
                        localStream.once('end', finalize);
                    }

                    localStream.once('error', err => callback(err));
                };

                if (this.content._resolve) {
                    let chunks = [];
                    let chunklen = 0;
                    let returned = false;
                    let sourceStream = this._getStream(this.content);
                    sourceStream.on('error', err => {
                        if (returned) return;
                        returned = true;
                        callback(err);
                    });
                    sourceStream.on('readable', () => {
                        let chunk;
                        while ((chunk = sourceStream.read()) !== null) {
                            chunks.push(chunk);
                            chunklen += chunk.length;
                        }
                    });
                    sourceStream.on('end', () => {
                        if (returned) return;
                        returned = true;
                        this.content._resolve = false;
                        this.content._resolvedValue = Buffer.concat(chunks, chunklen);
                        setImmediate(createStream);
                    });
                }
                else setImmediate(createStream);

                return;
            }
            else return setImmediate(finalize);
        };

        if (this._raw) {
            setImmediate(() => {
                // 如果内容是错误，则直接调用回
                if (Object.prototype.toString.call(this._raw) === '[object Error]') return callback(this._raw);

                // 移除默认错误处理程序（如果设置）
                if (typeof this._raw.pipe === 'function') this._raw.removeListener('error', this._contentErrorHandler);

                let raw = this._getStream(this._raw);
                raw.pipe(outputStream, {
                    end: false
                });
                raw.on('error', err => outputStream.emit('error', err));
                raw.on('end', finalize);
            });
        } else {
            outputStream.write(this.buildHeaders() + '\r\n\r\n');
            setImmediate(sendContent);
        }
    }

    /**
     * 设置要使用的信封而不是生成的信封
     *
     * @return {Object} SMTP信封，格式为 {from: 'from@example.com', to: ['to@example.com']}
     */
    setEnvelope(envelope) {
        let list;

        this._envelope = {
            from: false,
            to: []
        };

        if (envelope.from) {
            list = [];
            this._convertAddresses(this._parseAddresses(envelope.from), list);
            list = list.filter(address => address && address.address);
            if (list.length && list[0]) this._envelope.from = list[0].address;
        }

        ['to', 'cc', 'bcc'].forEach(key => {
            // 如果存在，则将地址添加到信封中
            if (envelope[key]) this._convertAddresses(this._parseAddresses(envelope[key]), this._envelope.to);
        });

        this._envelope.to = this._envelope.to.map(to => to.address).filter(address => address);

        let standardFields = ['to', 'cc', 'bcc', 'from'];
        Object.keys(envelope).forEach(key => {
            // 如果字段不是标准字段，则将其添加到信封中
            if (!standardFields.includes(key)) this._envelope[key] = envelope[key];
        });

        return this;
    }

    /**
     * 生成并返回包含解析后的地址字段的对象
     *
     * @return {Object} 地址对象
     */
    getAddresses() {
        let addresses = {};

        this._headers.forEach(header => {
            let key = header.key.toLowerCase();
            if (['from', 'sender', 'reply-to', 'to', 'cc', 'bcc'].includes(key)) {
                if (!Array.isArray(addresses[key])) addresses[key] = [];
                this._convertAddresses(this._parseAddresses(header.value), addresses[key]);
            }
        });

        return addresses;
    }

    /**
     * 生成并返回包含发件人地址和收件人地址列表的SMTP信封
     *
     * @return {Object} SMTP信封，格式为 {from: 'from@example.com', to: ['to@example.com']}
     */
    getEnvelope() {
        if (this._envelope) return this._envelope;

        let envelope = {
            from: false,
            to: []
        };
        this._headers.forEach(header => {
            let list = [];
            if (header.key === 'From' || (!envelope.from && ['Reply-To', 'Sender'].includes(header.key))) {
                this._convertAddresses(this._parseAddresses(header.value), list);
                if (list.length && list[0]) envelope.from = list[0].address;
            }
            else if (['To', 'Cc', 'Bcc'].includes(header.key))
                this._convertAddresses(this._parseAddresses(header.value), envelope.to);
        });
        envelope.to = envelope.to.map(to => to.address);

        return envelope;
    }

    /**
     * 返回Message-Id值。如果不存在，则创建一个
     *
     * @return {String} Message-Id值
     */
    messageId() {
        let messageId = this.getHeader('Message-ID');
        // 如果消息ID不存在，则生成一个
        if (!messageId) {
            messageId = this._generateMessageId();
            this.setHeader('Message-ID', messageId);
        }
        return messageId;
    }

    /**
     * 设置预生成的内容，该内容将用作此节点的输出
     *
     * @param {String|Buffer|Stream} 原始MIME内容
     */
    setRaw(raw) {
        this._raw = raw;

        if (this._raw && typeof this._raw.pipe === 'function') {
            // 预流处理程序。如果流被设置为内容，并且在此流执行任何操作之前触发'error'，则可能被触发
            this._contentErrorHandler = err => {
                this._raw.removeListener('error', this._contentErrorHandler);
                this._raw = err;
            };
            this._raw.once('error', this._contentErrorHandler);
        }

        return this;
    }

    /**
     * 检测并返回与内容相关的流的句柄。
     *
     * @param {Mixed} content 节点内容
     * @returns {Object} 流对象
     */
    _getStream(content) {
        let contentStream;

        if (content._resolvedValue) {
            // 将字符串或缓冲区内容作为流传递
            contentStream = new PassThrough();

            setImmediate(() => {
                try {
                    contentStream.end(content._resolvedValue);
                } catch (err) {
                    contentStream.emit('error', err);
                }
            });

            return contentStream;
        }
        // 否则，如果内容是流，则直接返回内容
        else if (typeof content.pipe === 'function') return content;
        // 否则，如果内容是文件路径，则返回文件流
        else if (content && typeof content.path === 'string' && !content.href) {
            if (this.disableFileAccess) {
                contentStream = new PassThrough();
                setImmediate(() => contentStream.emit('error', new Error('文件访问被拒绝：' + content.path)));
                return contentStream;
            }
            // 读取文件
            return fs.createReadStream(content.path);
        }
        // 否则，如果内容是URL，则返回URL流
        else if (content && typeof content.href === 'string') {
            if (this.disableUrlAccess) {
                contentStream = new PassThrough();
                setImmediate(() => contentStream.emit('error', new Error('URL访问被拒绝：' + content.href)));
                return contentStream;
            }
            // 获取URL
            return nmfetch(content.href, { headers: content.httpHeaders });
        }
        // 否则,将字符串或缓冲区内容作为流传递
        else {
            contentStream = new PassThrough();
            setImmediate(() => {
                try {
                    contentStream.end(content || '');
                } catch (err) {
                    contentStream.emit('error', err);
                }
            });
            return contentStream;
        }
    }

    /**
     * 解析地址。接受单个地址或数组或地址数组的数组（例如To: [[第一组], [第二组],...]）
     *
     * @param {Mixed} addresses 要解析的地址
     * @return {Array} 地址对象数组
     */
    _parseAddresses(addresses) {
        return [].concat.apply(
            [],
            [].concat(addresses).map(address => {
                // 如果地址和名称都存在，则将其转换为数组
                if (address && address.address) {
                    address.address = this._normalizeAddress(address.address);
                    address.name = address.name || '';
                    return [address];
                }
                return addressparser(address);
            })
        );
    }

    /**
     * 规范化头部键，使用驼峰式，除了大写的MIME-
     *
     * @param {String} key 要规范化的键
     * @return {String} 驼峰式形式的键
     */
    _normalizeHeaderKey(key) {
        resetRegex(regexs.REGEX_CRLF);
        resetRegex(regexs.REGEX_NORMALIZE_HEADER_KEY);
        key = (key || '')
            .toString()
            .replace(regexs.REGEX_CRLF, ' ') // 键中不能有换行符
            .trim()
            .toLowerCase()
            // 使用大写单词，除了MIME
            .replace(regexs.REGEX_NORMALIZE_HEADER_KEY, c => c.toUpperCase())
            .replace(regexs.CONTENT_FEATURES, 'Content-features');  // 特殊情况

        return key;
    }

    /**
     * 检查内容类型是否为多部分，并在需要时定义边界。
     * 不返回任何内容，而是修改对象参数。
     *
     * @param {Object} structured 为'Content-Type'键解析的头部值
     */
    _handleContentType(structured) {
        this.contentType = structured.value.trim().toLowerCase();
        this.multipart = regexs.MULTIPART.test(this.contentType) ? this.contentType.substring(this.contentType.indexOf('/') + 1) : false;

        if (this.multipart)
            this.boundary = structured.params.boundary = structured.params.boundary || this.boundary || this._generateBoundary();
        else this.boundary = false;
    }

    /**
     * 生成多部分边界值
     *
     * @return {String} 边界值
     */
    _generateBoundary() {
        return this.rootNode.boundaryPrefix + '-' + this.rootNode.baseBoundary + '-Part_' + this._nodeId;
    }

    /**
     * 对生成的rfc2822电子邮件中使用的头部值进行编码。
     *
     * @param {String} key 头部键
     * @param {String} value 头部值
     */
    _encodeHeaderValue(key, value) {
        key = this._normalizeHeaderKey(key);

        resetRegex(regexs.REGEX_CRLF);
        resetRegex(regexs.ANGLE_BRACKET);
        switch (key) {
            // 结构化头部
            case 'From':
            case 'Sender':
            case 'To':
            case 'Cc':
            case 'Bcc':
            case 'Reply-To': return this._convertAddresses(this._parseAddresses(value));
            // 用<>括起来的值
            case 'Message-ID':
            case 'In-Reply-To':
            case 'Content-Id':
                value = (value || '').toString().replace(regexs.REGEX_CRLF, ' ');
                if (value.charAt(0) !== '<') value = '<' + value;
                if (value.charAt(value.length - 1) !== '>') value = value + '>';
                return value;
            // 用<>括起来的值，以空格分隔的列表
            case 'References':
                value = [].concat
                    .apply(
                        [],
                        [].concat(value || '').map(elm => {
                            // eslint-disable-line prefer-spread
                            elm = (elm || '')
                                .toString()
                                .replace(regexs.REGEX_CRLF, ' ')
                                .trim();
                            return elm.replace(regexs.ANGLE_BRACKET, str => str.replace(regexs.WHITESPACE, '')).split(regexs.WHITESPACE);
                        })
                    )
                    .map(elm => {
                        if (elm.charAt(0) !== '<') elm = '<' + elm;
                        if (elm.charAt(elm.length - 1) !== '>') elm = elm + '>';
                        return elm;
                    });
                return value.join(' ').trim();
            case 'Date':
                if (value instanceof Date) return value.toUTCString().replace(/GMT/, '+0000');
                value = (value || '').toString().replace(regexs.REGEX_CRLF, ' ');
                return this._encodeWords(value);
            case 'Content-Type':
            // 如果包含文件名，则已编码
            case 'Content-Disposition': return (value || '').toString().replace(regexs.REGEX_CRLF, ' ');
            // 默认encodeWords仅在需要时编码，否则返回原始字符串
            default:
                value = (value || '').toString().replace(regexs.REGEX_CRLF, ' ');
                return this._encodeWords(value);
        }
    }

    /**
     * 使用punycode和其他调整重建地址对象
     *
     * @param {Array} addresses 地址对象数组
     * @param {Array} [uniqueList] 要填充地址的数组
     * @return {String} 地址字符串
     */
    _convertAddresses(addresses, uniqueList) {
        let values = [];

        uniqueList = uniqueList || [];

        [].concat(addresses || []).forEach(address => {
            if (address.address) {
                address.address = this._normalizeAddress(address.address);

                if (!address.name)
                    values.push(address.address.indexOf(' ') >= 0 ? `<${address.address}>` : `${address.address}`);
                else if (address.name) values.push(`${this._encodeAddressName(address.name)} <${address.address}>`);
                if (address.address) {
                    if (!uniqueList.filter(a => a.address === address.address).length) uniqueList.push(address);
                }
            }
            else if (address.group) {
                let groupListAddresses = (address.group.length ? this._convertAddresses(address.group, uniqueList) : '').trim();
                values.push(`${this._encodeAddressName(address.name)}:${groupListAddresses};`);
            }
        });

        return values.join(', ');
    }

    /**
     * 规范化电子邮件地址
     *
     * @param {Array} address 地址对象数组
     * @return {String} 地址字符串
     */
    _normalizeAddress(address) {
        resetRegex(regexs.FORBIDDEN_CHARS);
        address = (address || '')
            .toString()
            .replace(regexs.FORBIDDEN_CHARS, ' ') // 移除不允许的字符
            .trim();

        let lastAt = address.lastIndexOf('@');
        if (lastAt < 0) return address; // 没有@符号，保持原样

        let user = address.substring(0, lastAt);
        let domain = address.substring(lastAt + 1);

        // 域名默认使用punycode编码,非unicode域名保持原样(用户名),即使包含unicode
        // 'jõgeva.ee' 将被转换为 'xn--jgeva-dua.ee'

        let encodedDomain;

        try {
            encodedDomain = toASCII(domain.toLowerCase());
        } catch (err) { }

        if (user.includes(' ') >= 0) {
            if (!user.startsWith('"')) user = '"' + user;
            if (!user.endsWith('"')) user += '"';
        }

        return `${user}@${encodedDomain}`;
    }

    /**
     * 如果需要，对名称部分进行MIME编码
     *
     * @param {String} name 地址的名称部分
     * @returns {String} 如果需要，则为MIME字编码的字符串
     */
    _encodeAddressName(name) {
        if (!regexs.RALPHANUMERIC_UNDERSCORE_SPACE.test(name)) {
            resetRegex(regexs.QUOTED_PAIR);
            if (regexs.PRINTABLE_ASCII.test(name)) return '"' + name.replace(regexs.QUOTED_PAIR, '\\$1') + '"';
            else return encodeWord(name, this._getTextEncoding(name), 52);
        }
        return name;
    }

    /**
     * 如果需要，对名称部分进行MIME编码
     *
     * @param {String} name 地址的名称部分
     * @returns {String} 如果需要，则为MIME字编码的字符串
     */
    _encodeWords(value) {
        // 返回编码的字符串
        return encodeWords(value, this._getTextEncoding(value), 52, true);
    }

    /**
     * 检测文本值的最佳MIME编码
     *
     * @param {String} value 要检查的值
     * @return {String} 'Q'或'B'
     */
    _getTextEncoding(value) {
        value = (value || '').toString();

        let encoding = this.textEncoding;
        let latinLen;
        let nonLatinLen;

        if (!encoding) {
            resetRegex(regexs.NON_LATIN);
            resetRegex(regexs.LATIN);
            nonLatinLen = (value.match(regexs.NON_LATIN) || []).length;
            latinLen = (value.match(regexs.LATIN) || []).length;
            // 如果拉丁符号比二进制/unicode多，则首选Q，否则为B
            encoding = nonLatinLen < latinLen ? 'Q' : 'B';
        }
        return encoding;
    }

    /**
     * 生成消息ID
     *
     * @return {String} 随机Message-ID值
     */
    _generateMessageId() {
        return (
            '<' +
            [2, 2, 2, 6].reduce(
                // 生成类似UUID的随机字符串的关键代码
                (prev, len) => prev + '-' + randomBytes(len).toString('hex'),
                randomBytes(4).toString('hex')
            ) +
            '@' +
            // 尝试使用FROM地址的域名或回退到服务器主机名
            (this.getEnvelope().from || this.hostname || 'localhost').split('@').pop() +
            '>'
        );
    }
}

module.exports = MimeNode;