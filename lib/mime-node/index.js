'use strict';

// 引入必要的模块
const { PassThrough } = require('stream');
const { randomBytes } = require('crypto');

// 引入自定义模块
const { QpEncoder } = require('../qp');
const { Base64Encoder } = require('../base64');
const { toASCII } = require('../punycode');
const addressparser = require('../addressparser');
const { fs, nmfetch, regexs, resetRegex, callbackPromise, cleanup, resolveStream } = require('../shared');
const {
    detectMimeType, isPlainText, hasLongerLines, foldLines, parseHeaderValue, buildHeaderValue, encodeWord, encodeWords
} = require('../mime-funcs');

// 引入换行符处理模块
const LeWindows = require('./le-windows');
const LeUnix = require('./le-unix');
const LastNewline = require('./last-newline');

const B64 = 'base64', QP = 'quoted-printable';

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
        const { baseBoundary, boundaryPrefix = '--_NmP', disableFileAccess, disableUrlAccess, normalizeHeaderKey, rootNode,
            keepBcc, filename, textEncoding = '', parentNode, hostname, newline } = options;
        // 唯一多部分边界值的共享部分(Bcc默认不保留)
        this.baseBoundary = baseBoundary || randomBytes(8).toString('hex');
        this.boundaryPrefix = boundaryPrefix, this.normalizeHeaderKey = normalizeHeaderKey;
        this.disableFileAccess = !!disableFileAccess, this.disableUrlAccess = !!disableUrlAccess;
        this.keepBcc = !!keepBcc, this.rootNode = rootNode || this;

        // 如果指定了文件名但未指定内容类型(可能是附件, 则从文件扩展名检测内容类型)
        if (filename) {
            this.filename = filename;
            if (!contentType) contentType = detectMimeType(this.filename.split('.').pop());
        }

        this.newline = newline; // 如果设置为'win'则使用\r\n,如果为'linux'则使用\n;如果未设置(或使用`raw`),则换行符保持原样
        this.textEncoding = textEncoding.toString().trim().charAt(0).toUpperCase(); // 指示头部字符串应使用的编码："Q"或"B"
        this.parentNode = parentNode;                                               // 此节点的直接父节点(如果未设置则为undefined)
        this.hostname = hostname;                                                   // 默认message - id值使用的主机名

        this.date = new Date();                                 // 当前日期
        this.childNodes = [];                                   // 可能的子节点数组
        this._headers = [];                                     // 此节点的头部值列表，格式为[{ key: '', value: '' }]
        this._transforms = [];                                  // 在通过createReadStream暴露之前，消息将被管道传输的额外转换流
        this._processFuncs = [];                                // 在通过createReadStream暴露之前，消息将被管道传输的额外处理函数
        this._nodeId = ++this.rootNode.nodeCounter;             // 用于生成唯一边界值（前缀添加到共享基础值之前）
        this._isPlainText = false;                              // 如果内容仅使用ASCII可打印字符则为true
        this._hasLongLines = false;                             // 如果内容是纯文本但有超过允许长度的行则为true
        this._envelope = false;                                 // 如果设置，则使用此值作为信封而不是生成一个
        this._raw = false;                                      // 如果设置，则使用此值作为流内容而不是构建它
        if (contentType) this.setHeader('Content-Type', contentType); // 如果设置了内容类型(或从文件名派生),则将其添加到头部
    }

    /**
     * 创建并附加一个子节点。提供的参数传递给MimeNode构造函数
     *
     * @param {String} [contentType] 可选内容类型
     * @param {Object} [options] 可选选项对象
     * @return {Object} 创建的节点对象
     */
    createChild(contentType, options) {
        if (!options && typeof contentType === 'object') options = contentType, contentType = undefined;
        const node = new MimeNode(contentType, options);
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
        const rootNode = this.rootNode;
        if (childNode.rootNode !== rootNode) childNode.rootNode = rootNode, childNode._nodeId = ++rootNode.nodeCounter;
        childNode.parentNode = this, this.childNodes.push(childNode);
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
                node.rootNode = this.rootNode, node.parentNode = this.parentNode, node._nodeId = this._nodeId;
                this.rootNode = this, this.parentNode = undefined, node.parentNode.childNodes[i] = node;
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
        const { childNodes } = this.parentNode;
        for (let i = childNodes.length - 1; i >= 0; i--)
            if (childNodes[i] === this) {
                childNodes.splice(i, 1), this.parentNode = undefined, this.rootNode = this;
                return this;
            }
    }

    // 统一处理头部操作，支持多种输入格式和操作类型
    _processHeadersOp(key, value, singleOp, isSet) {
        // 如果是批量操作（没有value且key是对象）
        if (!value && key && typeof key === 'object') {
            // 允许{key:'content-type',value:'text/plain'},[{key:'content-type',value:'text/plain'}],{'content-type':'text/plain'}
            if (key.key && 'value' in key) singleOp.call(this, key.key, key.value);
            else if (Array.isArray(key)) key.forEach(i => singleOp.call(this, i.key, i.value));
            else Object.keys(key).forEach(i => singleOp.call(this, i, key[i]));
            return true; // 已处理批量操作
        }

        key = this._normalizeHeaderKey(key);                                       // 单个头部操作
        if (isSet) this._headers = this._headers.filter(item => item.key !== key); // set操作:先移除已存在的同名头部

        // add操作:添加新头部;否则直接添加
        if (!isSet && Array.isArray(value)) value.forEach(val => this._headers.push({ key, value: val }));
        else this._headers.push({ key, value });
        return false;    // 已处理单个操作
    }

    /**
     * 设置头部值。如果选定键的值已存在，则会被覆盖。
     * 可以使用[{key:'', value:''}]或{key: 'value'}作为第一个参数来设置多个值。
     *
     * @param {String|Array|Object} key 头部键或键值对列表
     * @param {String} value 头部值
     * @return {Object} 当前节点
     */
    setHeader(key, value) {
        // 如果未处理批量操作，说明是单个操作，已经在_processHeadersOp中处理完成
        if (!this._processHeadersOp(key, value, this.setHeader, true)); // true表示是set操作
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
        // 如果未处理批量操作，说明是单个操作，已经在_processHeadersOp中处理完成
        if (!this._processHeadersOp(key, value, this.addHeader, false)); // false表示是add操作
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
        for (let i = 0; i < this._headers.length; i++)
            if (this._headers[i].key === key) return this._headers[i].value;
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
                this.content.removeListener('error', this._contentErrorHandler), this.content = err;
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
        // 如果没有回调，则返回一个承诺，该承诺将在构建完成时解析
        const promise = !callback ? new Promise((resolve, reject) => callback = callbackPromise(resolve, reject)) : null;
        resolveStream(this.createReadStream(), callback); // 将流数据读取到Buffer中
        return promise;
    }

    // 获取编码类型
    getTransferEncoding() {
        let encoding = false;
        const contentType = (this.getHeader('Content-Type') || '').toString().toLowerCase().trim(), content = this.content;

        if (content) {
            encoding = (this.getHeader('Content-Transfer-Encoding') || '').toString().toLowerCase().trim();
            if (!encoding || ![B64, QP].includes(encoding)) {
                if (regexs.TEXT_TYPE.test(contentType)) {
                    if (this._isPlainText && !this._hasLongLines) encoding = '7bit';  // 如果没有特殊符号，则无需修改文本
                    else if (typeof content === 'string' || content instanceof Buffer) // 否则,内容是字符串或Buffer,则用QP或Base64
                        encoding = this._getTextEncoding(content) === 'Q' ? QP : B64;
                    else encoding = this.textEncoding === 'B' ? B64 : QP; // 否则,如果对于流,因无法检查内容,则使用首选编码或回退到QP
                }
                // 否则,如果不是 multipart 或 message 类型，默认使用 base64 编码
                else if (!regexs.MULTIPART_OR_MESSAGE.test(contentType)) encoding = encoding || B64;
            }
        }
        return encoding;
    }

    /**
     * 构建MIME节点的头部块。在写入内容之前追加 \r\n\r\n
     *
     * @returns {String} 头部
     */
    buildHeaders() {
        const tEncoding = this.getTransferEncoding(), C_DISPOSITION = 'Content-Disposition', DATE = 'Date',
            M_VERSION = 'MIME-Version', C_TYPE = 'Content-Type', headers = [], { filename, content } = this;

        if (tEncoding) this.setHeader('Content-Transfer-Encoding', tEncoding);
        if (filename && !this.getHeader(C_DISPOSITION)) this.setHeader(C_DISPOSITION, 'attachment');

        // 确保必需的头部字段
        if (this.rootNode === this) {
            this.messageId();
            if (!this.getHeader(DATE)) this.setHeader(DATE, this.date.toUTCString().replace('GMT', '+0000'));
            if (!this.getHeader(M_VERSION)) this.setHeader(M_VERSION, '1.0');

            // 确保根节点的Content-Type是最后一个头部
            for (let i = this._headers.length - 2; i >= 0; i--) {
                const header = this._headers[i];
                if (header.key === C_TYPE) this._headers.splice(i, 1), this._headers.push(header);
            }
        }

        this._headers.forEach(header => {
            let structured, param, value = header.value;
            const key = header.key, options = {},
                formattedHeaders = ['From', 'Sender', 'To', 'Cc', 'Bcc', 'Reply-To', 'Date', 'References'];

            if (value && typeof value === 'object' && !formattedHeaders.includes(key)) {
                Object.keys(value).forEach(key => {
                    if (key !== 'value') options[key] = value[key];
                });
                value = (value.value || '').toString();
                if (!value.trim()) return;
            }

            if (options.prepared) {
                const pushKV = `${key}:${value}`;
                options.foldLines ? headers.push(foldLines(pushKV)) : headers.push(pushKV); // 头部值已准备就绪
                return;
            }

            switch (key) {
                case C_DISPOSITION:
                    structured = parseHeaderValue(value);
                    if (filename) structured.params.filename = filename;
                    value = buildHeaderValue(structured);
                    break;
                case C_TYPE:
                    structured = parseHeaderValue(value), this._handleContentType(structured);
                    if (regexs.TEXT_PLAIN.test(structured.value) && typeof content === 'string' && regexs.NON_ASCII.test(content))
                        structured.params.charset = 'utf-8';

                    value = buildHeaderValue(structured);
                    if (filename) {
                        // 为非兼容客户端(如QQ网页邮件)添加支持,不能使用buildHeaderValue构建值,因为该值是非标准的,并且不支持参数;
                        param = this._encodeWords(filename);
                        // 如果参数与文件名匹配，则不添加参数。如果参数包含特殊字符，则添加引号。
                        if (param !== filename || regexs.UNSAFE_PARAM_VALUE.test(param)) param = `"${param}"`;
                        value += `;name=${param}`;
                    }
                    break;

                case 'Bcc':
                    if (!this.keepBcc) return; // 如果不保留Bcc，则不添加头部
                    break;
            }

            value = this._encodeHeaderValue(key, value);
            if (!value.toString().trim()) return; // 跳过空行
            // 如果存在自定义的normalizeHeaderKey函数，则使用它来规范化头部键
            if (typeof this.normalizeHeaderKey === 'function') {
                let normalized = this.normalizeHeaderKey(key, value);
                if (normalized && typeof normalized === 'string' && normalized.length) key = normalized;
            }

            headers.push(foldLines(`${key}:${value}`, 76));
        });

        return headers.join('\r\n');
    }

    /**
     * 从当前节点流式传输rfc2822消息。如果这是根节点，
     * 则设置缺失的必需头部字段（Date, Message-Id, MIME-Version）
     *
     * @return {String} 编译后的消息 */
    createReadStream(options = {}) {
        const stream = new PassThrough(options);
        let outputStream = stream, transform;

        // 处理流的错误传递和管道连接
        const pipeStream = (source, transform) => {
            source.once('error', err => transform.emit('error', err));
            return source.pipe(transform);
        };

        this.stream(stream, options, err => {
            if (err) return outputStream.emit('error', err);
            stream.end();
        });

        // 处理所有转换流
        for (let i = 0; i < this._transforms.length; i++) {
            transform = typeof this._transforms[i] === 'function' ? this._transforms[i]() : this._transforms[i];
            outputStream = pipeStream(outputStream, transform);
        }

        // 在可能的用户转换之后确保终止换行符
        transform = new LastNewline(), outputStream = pipeStream(outputStream, transform);

        // 循环遍历所有后处理函数，并将输出流传递给每个函数。
        for (let i = 0; i < this._processFuncs.length; i++) {
            transform = this._processFuncs[i], outputStream = transform(outputStream);
        }

        if (this.newline) {
            const winbreak = ['win', 'windows', 'dos', '\r\n'].includes(this.newline.toString().toLowerCase()),
                nTransform = winbreak ? new LeWindows() : new LeUnix(), newStream = outputStream.pipe(nTransform);
            outputStream.on('error', err => newStream.emit('error', err));
            return newStream;
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

    // 将当前节点流式传输到输出流
    stream(outputStream, options, done) {
        const transferEncoding = this.getTransferEncoding(), state = { returned: false };// 防止多次返回
        let contentStream, localStream;
        function callback(args) {
            cleanup(state), done(args);
        };

        // 对于多部分节点，推送子节点;对于内容节点，结束流
        const finalize = () => {
            let childId = 0;
            const processChildNode = () => {
                if (childId >= this.childNodes.length) {
                    outputStream.write(`\r\n--${this.boundary}--\r\n`);
                    return callback();
                }
                const child = this.childNodes[childId++];
                outputStream.write(`${childId > 1 ? '\r\n' : ''}--${this.boundary}\r\n`);
                child.stream(outputStream, options, err => {
                    if (err) return callback(err);
                    setImmediate(processChildNode);
                });
            };

            if (this.multipart) setImmediate(processChildNode);
            else return callback();
        };

        // 推送节点内容
        const sendContent = () => {
            const content = this.content;
            if (content) {
                // 如果内容是错误，则直接调用回调
                if (Object.prototype.toString.call(content) === '[object Error]') return callback(content);

                if (typeof content.pipe === 'function') {
                    content.removeListener('error', this._contentErrorHandler);
                    this._contentErrorHandler = err => callback(err), content.once('error', this._contentErrorHandler);
                }

                const createStream = () => {
                    if ([QP, B64].includes(transferEncoding)) {
                        contentStream = new (transferEncoding === B64 ? Base64Encoder : QpEncoder)(options);
                        contentStream.pipe(outputStream, { end: false });
                        contentStream.once('end', finalize).once('error', err => callback(err));
                        localStream = this._getStream(content), localStream.pipe(contentStream);
                    } else {
                        // 任何不是QP或Base54的内容都按原样传递
                        localStream = this._getStream(content), localStream.pipe(outputStream, { end: false });
                        localStream.once('end', finalize);
                    }

                    localStream.once('error', err => callback(err));
                };

                if (content._resolve) {
                    // 将流数据读取到Buffer中
                    resolveStream(this._getStream(content), (err, resolvedValue) => {
                        if (err) return callback(err);
                        content._resolve = false, content._resolvedValue = resolvedValue, setImmediate(createStream);
                    });
                }
                else setImmediate(createStream);

                return;
            }
            return setImmediate(finalize);
        };

        if (this._raw) {
            setImmediate(() => {
                // 如果内容是错误，则直接调用回调;如果设置错误处理程序，则将其移除
                if (Object.prototype.toString.call(this._raw) === '[object Error]') return callback(this._raw);
                if (typeof this._raw.pipe === 'function') this._raw.removeListener('error', this._contentErrorHandler);

                const raw = this._getStream(this._raw);
                raw.pipe(outputStream, { end: false }), raw.on('end', finalize).on('error', err => outputStream.emit('error', err));
            });
        }
        else outputStream.write(`${this.buildHeaders()}\r\n\r\n`), setImmediate(sendContent);
    }

    /**
     * 设置要使用的信封而不是生成的信封
     *
     * @return {Object} SMTP信封，格式为 {from: 'from@example.com', to: ['to@example.com']}
     */
    setEnvelope(envelope) {
        this._envelope = { from: false, to: [] };
        if (envelope.from) {
            let list = [];
            this._convertAddresses(this._parseAddresses(envelope.from), list);
            list = list.filter(address => address?.address);
            if (list.length && list[0]) this._envelope.from = list[0].address;
        }

        const { to } = this._envelope, standardFields = ['to', 'cc', 'bcc', 'from'];
        ['to', 'cc', 'bcc'].forEach(key => {
            if (envelope[key]) this._convertAddresses(this._parseAddresses(envelope[key]), to); // 如果存在，则将地址添加到信封中
        });
        this._envelope.to = to.map(to => to.address).filter(address => address);
        Object.keys(envelope).forEach(key => {
            if (!standardFields.includes(key)) this._envelope[key] = envelope[key];     // 如果字段不是标准字段,则将其添加到信封中
        });

        return this;
    }

    /**
     * 生成并返回包含解析后的地址字段的对象
     *
     * @return {Object} 地址对象
     */
    getAddresses() {
        const addresses = {};
        this._headers.forEach(header => {
            const key = header.key.toLowerCase();
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

        const envelope = { from: false, to: [] }, { from, to } = envelope;
        this._headers.forEach(header => {
            const list = [], { key, value } = header;
            if (key === 'From' || (!from && ['Reply-To', 'Sender'].includes(key))) {
                this._convertAddresses(this._parseAddresses(value), list);
                if (list.length && list[0]) envelope.from = list[0].address;
            }
            else if (['To', 'Cc', 'Bcc'].includes(key)) this._convertAddresses(this._parseAddresses(value), to);
        });
        envelope.to = to.map(to => to.address);
        return envelope;
    }

    /**
     * 返回Message-Id值。如果不存在，则创建一个
     *
     * @return {String} Message-Id值
     */
    messageId() {
        return this.getHeader('Message-ID') || this.setHeader('Message-ID', this._generateMessageId());
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
                this._raw.removeListener('error', this._contentErrorHandler), this._raw = err;
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
    _getStream(content = {}) {
        // 创建并返回一个立即触发错误的流
        const createErrorStream = message => {
            const errorStream = new PassThrough();
            setImmediate(() => errorStream.emit('error', new Error(message)));
            return errorStream;
        },

            // 创建并返回包含指定数据的流
            createContentStream = data => {
                const stream = new PassThrough();
                setImmediate(() => {
                    try {
                        stream.end(data);
                    } catch (err) {
                        stream.emit('error', err);
                    }
                });
                return stream;
            }, { _resolvedValue, pipe, path, href, httpHeaders } = content;
        if (_resolvedValue) return createContentStream(_resolvedValue);  // 处理已解析的字符串或Buffer类型内容
        else if (typeof pipe === 'function') return content;             // 如果是流本身，则直接返回该流
        // 如果是文件路径：根据访问权限返回文件流或错误流
        else if (content && typeof path === 'string' && !href)
            return this.disableFileAccess ? createErrorStream(`文件访问被拒绝:${path}`) : fs.createReadStream(path);
        // 如果是URL：根据访问权限返回网络流或错误流
        else if (content && typeof href === 'string')
            return this.disableUrlAccess ? createErrorStream(`URL访问被拒绝:${href}`) : nmfetch(href, { headers: httpHeaders });
        return createContentStream(content || '');                       // 兜底处理：将其他类型内容转换为流
    }

    /**
     * 解析地址。接受单个地址或数组或地址数组的数组（例如To: [[第一组], [第二组],...]）
     *
     * @param {Mixed} addresses 要解析的地址
     * @return {Array} 地址对象数组
     */
    _parseAddresses(addresses) {
        return [].concat.apply([], [].concat(addresses).map(mAddress => {
            // 如果地址和名称都存在，则将其转换为数组
            if (mAddress?.address) {
                const { address, name = '' } = mAddress;
                mAddress.address = this._normalizeAddress(address), mAddress.name = name;
                return [mAddress];
            }
            return addressparser(mAddress);
        }));
    }

    /**
     * 规范化头部键，使用驼峰式，除了大写的MIME-
     *
     * @param {String} key 要规范化的键
     * @return {String} 驼峰式形式的键
     */
    _normalizeHeaderKey(key = '') {
        const rL = resetRegex(regexs.LINEBREAKS), rNHK = resetRegex(regexs.NORMALIZE_HEADER_KEY);
        // 转换为字符串,删除换行符,行首和行尾空格并转换为小写, 使用大写单词(除了MIME),特殊处理Content-features头部
        key = key.toString().replace(rL, ' ').trim().toLowerCase().replace(rNHK, c => c.toUpperCase())
            .replace(regexs.CONTENT_FEATURES, 'Content-features');

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
        this.multipart = regexs.MULTIPART.test(this.contentType) && this.contentType.split('/')[1];
        this.boundary = this.multipart ? structured.params.boundary = this.boundary || this._generateBoundary() : false;
    }

    /**
     * 生成多部分边界值
     *
     * @return {String} 边界值
     */
    _generateBoundary() {
        return `${this.rootNode.boundaryPrefix}-${this.rootNode.baseBoundary}-Part_${this._nodeId}`;
    }

    /**
     * 对生成的rfc2822电子邮件中使用的头部值进行编码。
     *
     * @param {String} key 头部键
     * @param {String} value 头部值
     */
    _encodeHeaderValue(key, value = '') {
        key = this._normalizeHeaderKey(key);
        const rL = resetRegex(regexs.LINEBREAKS), rAB = resetRegex(regexs.ANGLE_BRACKET), rBR = resetRegex(regexs.BLANK_REGEX),
            cleanValue = (val = '') => {
                return val.toString().replace(rL, ' '); // 将值转换为字符串，并替换掉换行符
            },

            ensureAngleBrackets = (val) => {
                if (!val.startsWith('<')) val = `<${val}`;
                if (!val.endsWith('>')) val += '>';
                return val; // 确保字符串以'<'开头和以'>'结尾
            };
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
                return ensureAngleBrackets(this._encodeWords(cleanValue(value)));
            // 用<>括起来的值，以空格分隔的列表
            case 'References':
                value = [].concat(value)
                    // 将值转换为字符串,删除尖括号中的空白字符,然后按空白字符分割
                    .flatMap(ref => cleanValue(ref).trim().replace(rAB, m => m.replace(rBR, '')).split(regexs.WHITESPACE))
                    .map(ensureAngleBrackets);
                return this._encodeWords(value.join(' ').trim());
            case 'Date':
                if (value instanceof Date) return value.toUTCString().replace('GMT', '+0000');
                return this._encodeWords(cleanValue(value));
            case 'Content-Type':
            case 'Content-Disposition': return cleanValue(value); // 如果包含文件名，则已编码
            default: return this._encodeWords(cleanValue(value)); // 默认encodeWords仅在需要时编码，否则返回原始字符串
        }
    }

    /**
     * 使用punycode和其他调整重建地址对象
     *
     * @param {Array} addresses 地址对象数组
     * @param {Array} [uniqueList] 要填充地址的数组
     * @return {String} 地址字符串
     */
    _convertAddresses(addresses = [], uniqueList = []) {
        const values = [];
        [].concat(addresses).forEach(addrObj => {
            const { address, name, group } = addrObj;
            if (address) {
                const normAddr = this._normalizeAddress(address);
                if (!name) values.push(normAddr.includes(' ') ? `<${normAddr}>` : normAddr);
                else if (name) values.push(`${this._encodeAddressName(name)} <${normAddr}>`);

                if (!uniqueList.some(a => this._normalizeAddress(a.address) === normAddr)) uniqueList.push(addrObj);
            }
            else if (group) {
                const groupListAddresses = (group.length ? this._convertAddresses(group, uniqueList) : '').trim();
                values.push(`${this._encodeAddressName(name)}:${groupListAddresses};`);
            }
        });

        return values.join(',');
    }

    /**
     * 规范化电子邮件地址
     *
     * @param {Array} address 地址对象数组
     * @return {String} 地址字符串
     */
    _normalizeAddress(address = '') {
        const rFC = resetRegex(regexs.FORBIDDEN_CHARS);
        address = address.toString().replace(rFC, ' ').trim();

        const lIndex = address.lastIndexOf('@');
        if (lIndex < 0) return address; // 没有@符号，保持原样

        let user = address.substring(0, lIndex), encodedDomain;
        const domain = address.substring(lIndex + 1);

        // 域名默认使用punycode编码,非unicode域名保持原样(用户名),即使包含unicode;'jõgeva.ee'将被转换为'xn--jgeva-dua.ee'
        try {
            encodedDomain = toASCII(domain.toLowerCase());
        } catch (err) { }

        if (user.includes(' ')) {
            if (!user.startsWith('"')) user = `"${user}`;
            if (!user.endsWith('"')) user += '"';
        }

        return `${user}@${encodedDomain}`;
    }

    /**
     * 对邮件地址中的名称部分进行编码处理
     * 如果名称包含非ASCII字符或特殊字符，则进行MIME编码或引号包裹
     *
     * @param {String} name 邮件地址中的名称部分（如 "张三" in "张三<zhangsan@example.com>"）
     * @returns {String} 编码后的名称字符串
     */
    _encodeAddressName(name) {
        const { QUOTED_PAIR: rQP, RALPHANUMERIC_UNDERSCORE_SPACE: rRUS, PRINTABLE_ASCII: rPA } = regexs;

        if (!rRUS.test(name)) {
            resetRegex(rQP);
            return rPA.test(name) ? `"${name.replace(rQP, '\\$1')}"` : encodeWord(name, this._getTextEncoding(name), 52);
        }
        return name;
    }

    /**
     * 对邮件头字段值进行MIME编码字编码
     * 主要用于编码包含非ASCII字符的主题、注释等字段值
     *
     * @param {String} value 需要编码的邮件头字段值
     * @returns {String} MIME编码字编码后的字符串
     */
    _encodeWords(value) {
        return encodeWords(value, this._getTextEncoding(value), 52, true);
    }

    /**
     * 检测文本值的最佳MIME编码
     *
     * @param {String} value 要检查的值
     * @return {String} 'Q'或'B'
     */
    _getTextEncoding(value = '') {
        value = value.toString();
        if (this.textEncoding) return this.textEncoding;  // 如果有预设编码，直接返回
        const rNL = resetRegex(regexs.NON_LATIN), rL = resetRegex(regexs.LATIN),
            nonLatinLen = (value.match(rNL) || []).length, latinLen = (value.match(rL) || []).length;
        return nonLatinLen < latinLen ? 'Q' : 'B';
    }

    /**
     * 生成消息ID
     *
     * @return {String} 随机Message-ID值
     */
    _generateMessageId() {
        // 使用不同长度的随机字节生成类似UUID的格式,优先使用发件人地址中的域名，服务器主机名或localhost次之
        const randomPart = [4, 2, 2, 2, 6].map(len => randomBytes(len).toString('hex')).join('-'),
            domain = (this.getEnvelope().from || this.hostname || 'localhost').split('@').pop();
        return `<${randomPart}@${domain}>`; // 返回符合RFC标准的Message-ID格式
    }
}

module.exports = MimeNode;