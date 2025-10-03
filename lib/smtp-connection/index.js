'use strict';

// 导入依赖包
const net = require('net');
const tls = require('tls');
const os = require('os');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const { randomBytes, createHmac } = require('crypto');
const packageInfo = require('../../package.json');
const DataStream = require('./data-stream');
const { getLogger, resolveHostname, callbackPromise, encodeXText } = require('../shared');

// 默认超时时间（毫秒）
const CONNECTION_TIMEOUT = 2 * 60 * 1000; // 连接建立超时时间
const SOCKET_TIMEOUT = 10 * 60 * 1000; // 套接字无活动超时时间
const GREETING_TIMEOUT = 30 * 1000; // 连接建立后等待SMTP问候消息的超时时间
const DNS_TIMEOUT = 30 * 1000; // DNS解析超时时间

// 正则表达式
const REGEX_STARTTLS = /[ -]STARTTLS\b/im;
const REGEX_SMTPUTF8 = /[ -]SMTPUTF8\b/im;
const REGEX_DSN = /[ -]DSN\b/im;
const REGEX_8BITMIME = /[ -]8BITMIME\b/im;
const REGEX_PIPELINING = /[ -]PIPELINING\b/im;
const REGEX_AUTH = /[ -]AUTH\b/i;
const REGEX_AUTH_MECHANISM = /[ -]AUTH(?:(\s+|=)[^\n]*\s+|\s+|=)/i;
const REGEX_SIZE = /[ -]SIZE(?:[ \t]+(\d+))?/im;

/**
 * 生成SMTP连接对象
 *
 * 可选的选项对象可以包含以下属性：
 *
 *  **port** - 连接的端口（默认为587或465）
 *  **host** - 连接的主机名或IP地址（默认为'localhost'）
 *  **secure** - 使用SSL
 *  **ignoreTLS** - 忽略服务器对STARTTLS的支持
 *  **requireTLS** - 强制客户端使用STARTTLS
 *  **name** - 客户端服务器名称
 *  **localAddress** - 绑定的出站地址
 *  **greetingTimeout** - 等待服务器问候消息的超时时间（毫秒）
 *  **connectionTimeout** - 等待连接建立的超时时间（毫秒）
 *  **socketTimeout** - 连接关闭前的无活动超时时间（默认为1小时）
 *  **dnsTimeout** - 等待DNS请求解析的超时时间（默认为30秒）
 *  **lmtp** - 如果为true，使用LMTP而不是SMTP协议
 *  **logger** - bunyan兼容的日志接口
 *  **debug** - 如果为true，将SMTP流量传递给日志记录器
 *  **tls** - createCredentials的选项
 *  **socket** - 使用现有套接字而不是创建新套接字
 *  **secured** - 布尔值，指示提供的套接字是否已升级到TLS
 *
 * @constructor
 * @namespace SMTP Client module
 * @param {Object} [options] 选项属性
 */
class SmtpConnection extends EventEmitter {
    constructor(option = {}) {
        super(options);

        // 生成随机连接ID
        this.id = randomBytes(8).toString('base64').replace(/\W/g, '');
        this.stage = 'init';
        this.options = options;
        this.secureConnection = !!this.options.secure;
        this.alreadySecured = !!this.options.secured;
        this.port = Number(this.options.port) || (this.secureConnection ? 465 : 587);
        this.host = this.options.host || 'localhost';
        this.servername = this.options.servername ? this.options.servername : !net.isIP(this.host) ? this.host : false;
        this.allowInternalNetworkInterfaces = this.options.allowInternalNetworkInterfaces || false;

        // 如果secure选项未设置但端口是465，则默认为安全连接
        if (typeof this.options.secure === 'undefined' && this.port === 465) this.secureConnection = true;
        this.name = this.options.name || this._getHostname();

        // 设置日志记录器
        this.logger = getLogger(this.options, {
            component: this.options.component || 'smtpConnection',
            sid: this.id
        });

        // 初始化自定义认证方法
        this.customAuth = new Map();
        Object.keys(this.options.customAuth || {}).forEach(key => {
            let mapKey = (key || '').toString().trim().toUpperCase();

            if (!mapKey) return;
            this.customAuth.set(mapKey, this.options.customAuth[key]);
        });

        this.version = packageInfo.version;     // 暴露版本号
        this.authenticated = false;             // 如果为true，则表示用户已认证
        this.destroyed = false;                 // 如果设置为true，此实例不再活跃
        this.secure = !!this.secureConnection;  // 定义当前连接是否安全。如果不安全，如果服务器支持，可以使用STARTTLS
        this._remainder = '';                   // 存储来自服务器的不完整消息
        this._responseQueue = [];               // 来自服务器的未处理响应队列
        this.lastServerResponse = false;        // 最后的服务器响应,如果没有响应，则为false
        this._socket = false;                   // 连接到服务器的套接字,如果没有套接字，则为false
        this._supportedAuth = [];               // 列出支持的认证机制列表
        this.allowsAuth = false;                // 如果EHLO响应包含"AUTH"，则设置为true。如果为false，则不尝试认证
        this._envelope = false;                 // 包含当前信封（发件人，收件人）的对象,如果没有信封，则为false
        this._supportedExtensions = [];         // 列出支持的扩展列表
        this._maxAllowedSize = 0;               // 定义单个消息允许的最大大小
        this._responseActions = [];             // 当从服务器接收到数据块时要运行的函数队列
        this._recipientQueue = [];              // 这个队列包含要发送的收件人列表
        this._greetingTimeout = false;          // 等待问候消息的超时变量,如果为true，则表示已超时
        this._connectionTimeout = false;        // 等待连接开始的超时变量,如果为true，则表示已超时
        this._destroyed = false;                // 如果套接字被认为已关闭，则设置为true
        this._closing = false;                  // 如果套接字正在关闭，则设置为true

        /**
         * 套接字监听器的回调函数
         */
        this._onSocketData = chunk => this._onData(chunk);
        this._onSocketError = error => this._onError(error, 'ESOCKET', false, 'CONN');
        this._onSocketClose = () => this._onClose();
        this._onSocketEnd = () => this._onEnd();
        this._onSocketTimeout = () => this._onTimeout();
    }

    /**
     * 设置连接处理器
     */
    _setupConnectionHandlers() {
        this._connectionTimeout = setTimeout(() => {
            this._onError('连接超时', 'ETIMEDOUT', false, 'CONN');
        }, this.options.connectionTimeout || CONNECTION_TIMEOUT);

        this._socket.on('error', this._onSocketError);
    }

    /**
     * 处理 DNS 解析和连接建立
     */
    _resolveAndConnect(opts, connectCallback) {
        resolveHostname(opts, (err, resolved) => {
            if (err) return setImmediate(() => this._onError(err, 'EDNS', false, 'CONN'));

            this._logDnsResolution(opts.host, resolved);
            Object.keys(resolved).forEach(key => {
                if (key.charAt(0) !== '_' && resolved[key]) opts[key] = resolved[key];
            });

            try {
                connectCallback(opts);
                this._setupConnectionHandlers();
            } catch (E) {
                return setImmediate(() => this._onError(E, 'ECONNECTION', false, 'CONN'));
            }
        });
    }

    /**
     * 记录 DNS 解析日志
     */
    _logDnsResolution(source, resolved) {
        this.logger.debug(
            {
                tnx: 'dns',
                source: source,
                resolved: resolved.host,
                cached: !!resolved.cached
            },
            '将 %s 解析为 %s [缓存 %s]',
            source,
            resolved.host,
            resolved.cached ? '命中' : '未命中'
        );
    }

    /**
     * 创建到SMTP服务器的连接并设置连接监听器
     */
    connect(connectCallback) {
        if (typeof connectCallback === 'function') {
            this.once('connect', () => {
                this.logger.debug(
                    {
                        tnx: 'smtp'
                    },
                    'SMTP握手完成'
                );
                connectCallback();
            });

            const isDestroyedMessage = this._isDestroyedMessage('connect');
            if (isDestroyedMessage) return connectCallback(this._formatError(isDestroyedMessage, 'ECONNECTION', false, 'CONN'));
        }

        let opts = {
            port: this.port,
            host: this.host,
            allowInternalNetworkInterfaces: this.allowInternalNetworkInterfaces,
            timeout: this.options.dnsTimeout || DNS_TIMEOUT
        };
        if (this.options.localAddress) opts.localAddress = this.options.localAddress;

        // 如果已提供连接对象，则使用它
        if (this.options.connection) {
            this._socket = this.options.connection;
            this._setupConnectionHandlers();

            if (this.secureConnection && !this.alreadySecured) {
                setImmediate(() =>
                    this._upgradeConnection(err => {
                        if (err) {
                            this._onError(new Error('启动TLS错误 - ' + (err.message || err)), 'ETLS', false, 'CONN');
                            return;
                        }
                        this._onConnect();
                    })
                );
            }
            else setImmediate(() => this._onConnect());

            return;
        }
        // 否则,如果套接字已设置，则使用它
        else if (this.options.socket) {
            this._socket = this.options.socket;
            return this._resolveAndConnect(opts, (resolvedOpts) => {
                this._socket.connect(this.port, this.host, () => {
                    this._socket.setKeepAlive(true);
                    this._onConnect();
                });
            });
        }
        // 否则,如果secureConnection为true，则使用TLS连接
        else if (this.secureConnection) {
            if (this.options.tls)
                Object.keys(this.options.tls).forEach(key => {
                    opts[key] = this.options.tls[key];
                });

            // 确保SNI的服务器名称
            if (this.servername && !opts.servername) opts.servername = this.servername;

            return this._resolveAndConnect(opts, (resolvedOpts) => {
                this._socket = tls.connect(resolvedOpts, () => {
                    this._socket.setKeepAlive(true);
                    this._onConnect();
                });
            });
        }
        // 否则,则使用明文连接
        else
            return this._resolveAndConnect(opts, (resolvedOpts) => {
                this._socket = net.connect(resolvedOpts, () => {
                    this._socket.setKeepAlive(true);
                    this._onConnect();
                });
            });
    }

    /**
     * 发送QUIT命令
     */
    quit() {
        this._sendCommand('QUIT');
        this._responseActions.push(this.close);
    }

    /**
     * 关闭与服务器的连接
     */
    close() {
        clearTimeout(this._connectionTimeout);
        clearTimeout(this._greetingTimeout);
        this._responseActions = [];

        // 确保此函数只运行一次
        if (this._closing) return;
        this._closing = true;

        let closeMethod = 'end';
        if (this.stage === 'init') closeMethod = 'destroy'; // 连接超时时立即关闭套接字

        this.logger.debug(
            {
                tnx: 'smtp'
            },
            '使用"%s"关闭与服务器的连接',
            closeMethod
        );

        let socket = (this._socket && this._socket.socket) || this._socket;

        if (socket && !socket.destroyed) {
            try {
                socket[closeMethod]();
            } catch (E) { }
        }

        this._destroy();
    }

    /**
    * 生成AUTH PLAIN认证字符串
    */
    _generateAuthPlainString(includePassword = true) {
        const credentials = includePassword ?
            this._auth.credentials.pass : '/* secret */';

        return Buffer.from(
            '\u0000' + // 跳过授权标识，因为某些服务器会有问题
            this._auth.credentials.user +
            '\u0000' +
            credentials,
            'utf-8'
        ).toString('base64');
    }

    /**
     * 用户认证
     */
    login(authData, callback) {
        const isDestroyedMessage = this._isDestroyedMessage('login');
        if (isDestroyedMessage) return callback(this._formatError(isDestroyedMessage, 'ECONNECTION', false, 'API'));

        this._auth = authData || {};
        // 选择SASL认证方法
        this._authMethod = (this._auth.method || '').toString().trim().toUpperCase() || false;
        // 如果没有指定认证方法，则使用XOAUTH2认证，如果没有OAuth2凭据，则使用PLAIN认证
        if (!this._authMethod && this._auth.oauth2 && !this._auth.credentials) this._authMethod = 'XOAUTH2';
        else if (!this._authMethod || (this._authMethod === 'XOAUTH2' && !this._auth.oauth2))
            this._authMethod = (this._supportedAuth[0] || 'PLAIN').toUpperCase().trim();

        // 如果没有指定凭据，则使用用户名和密码
        if (this._authMethod !== 'XOAUTH2' && (!this._auth.credentials || !this._auth.credentials.user
            || !this._auth.credentials.pass)) {
            if ((this._auth.user && this._auth.pass) || this.customAuth.has(this._authMethod)) {
                this._auth.credentials = {
                    user: this._auth.user,
                    pass: this._auth.pass,
                    options: this._auth.options
                };
            }
            else return callback(this._formatError('缺少 "' + this._authMethod + '" 的凭据', 'EAUTH', false, 'API'));
        }

        if (this.customAuth.has(this._authMethod)) {
            let handler = this.customAuth.get(this._authMethod);
            let lastResponse;
            let returned = false;

            let resolve = () => {
                if (returned) return;
                returned = true;

                this.logger.info(
                    {
                        tnx: 'smtp',
                        username: this._auth.user,
                        action: 'authenticated',
                        method: this._authMethod
                    },
                    '用户 %s 已认证',
                    JSON.stringify(this._auth.user)
                );
                this.authenticated = true;
                callback(null, true);
            };

            let reject = err => {
                if (returned) return;
                returned = true;

                callback(this._formatError(err, 'EAUTH', lastResponse, 'AUTH ' + this._authMethod));
            };

            let handlerResponse = handler({
                auth: this._auth,
                method: this._authMethod,

                extensions: [].concat(this._supportedExtensions),
                authMethods: [].concat(this._supportedAuth),
                maxAllowedSize: this._maxAllowedSize || false,

                sendCommand: (cmd, done) => {
                    let promise;

                    if (!done)
                        promise = new Promise((resolve, reject) => {
                            done = callbackPromise(resolve, reject);
                        });

                    this._responseActions.push(str => {
                        lastResponse = str;

                        let codes = str.match(/^(\d+)(?:\s(\d+\.\d+\.\d+))?\s/);
                        let data = {
                            command: cmd,
                            response: str
                        };
                        if (codes) {
                            data.status = Number(codes[1]) || 0;
                            if (codes[2]) data.code = codes[2];
                            data.text = str.substring(codes[0].length);
                        }
                        else {
                            data.text = str;
                            data.status = 0; // 以防需要进行数字比较
                        }
                        done(null, data);
                    });
                    setImmediate(() => this._sendCommand(cmd));

                    return promise;
                },

                resolve,
                reject
            });

            // 如果返回了Promise，则等待Promise完成
            if (handlerResponse && typeof handlerResponse.catch === 'function') handlerResponse.then(resolve).catch(reject);

            return;
        }

        switch (this._authMethod) {
            case 'XOAUTH2':
                this._handleXOauth2Token(false, callback);
                return;
            case 'LOGIN':
                this._responseActions.push(str => {
                    this._actionAUTH_LOGIN_USER(str, callback);
                });
                this._sendCommand('AUTH LOGIN');
                return;
            case 'PLAIN':
                this._responseActions.push(str => {
                    this._actionAUTHComplete(str, callback);
                });
                this._sendCommand(
                    'AUTH PLAIN ' + this._generateAuthPlainString(true),
                    'AUTH PLAIN ' + this._generateAuthPlainString(false)  // 日志条目不包含密码
                );
                return;
            case 'CRAM-MD5':
                this._responseActions.push(str => {
                    this._actionAUTH_CRAM_MD5(str, callback);
                });
                this._sendCommand('AUTH CRAM-MD5');
                return;
        }

        return callback(this._formatError('未知的认证方法 "' + this._authMethod + '"', 'EAUTH', false, 'API'));
    }

    /**
     * 发送消息
     *
     * @param {Object} envelope 信封对象，{from: addr, to: [addr]}
     * @param {Object} message 字符串、缓冲区或流
     * @param {Function} callback 发送完成后调用的回调函数
     */
    send(envelope, message, done) {
        if (!message) return done(this._formatError('空消息', 'EMESSAGE', false, 'API'));

        const isDestroyedMessage = this._isDestroyedMessage('send message');
        if (isDestroyedMessage) return done(this._formatError(isDestroyedMessage, 'ECONNECTION', false, 'API'));

        // 拒绝大于允许大小的消息
        if (this._maxAllowedSize && envelope.size > this._maxAllowedSize)
            return setImmediate(() => {
                done(this._formatError('消息大小超过允许值 ' + this._maxAllowedSize, 'EMESSAGE', false, 'MAIL FROM'));
            });

        // 确保回调只被调用一次
        let returned = false;
        let callback = function () {
            if (returned) return;
            returned = true;

            done(...arguments);
        };

        if (typeof message.on === 'function') message.on('error', err => callback(this._formatError(err, 'ESTREAM', false, 'API')));

        let startTime = Date.now();
        this._setEnvelope(envelope, (err, info) => {
            if (err) {
                // 创建直通流来消耗数据以防止内存不足
                let stream = new PassThrough();
                if (typeof message.pipe === 'function') message.pipe(stream);
                else {
                    stream.write(message);
                    stream.end();
                }

                return callback(err);
            }
            let envelopeTime = Date.now();
            let stream = this._createSendStream((err, str) => {
                if (err) return callback(err);

                info.envelopeTime = envelopeTime - startTime;
                info.messageTime = Date.now() - envelopeTime;
                info.messageSize = stream.outByteCount;
                info.response = str;

                return callback(null, info);
            });
            if (typeof message.pipe === 'function') message.pipe(stream);
            else {
                stream.write(message);
                stream.end();
            }
        });
    }

    /**
     * 重置连接状态
     *
     * @param {Function} callback 连接重置后调用的回调函数
     */
    reset(callback) {
        this._sendCommand('RSET');
        this._responseActions.push(str => {
            if (str.charAt(0) !== '2') return callback(this._formatError('无法重置会话状态。响应=' + str, 'EPROTOCOL', str, 'RSET'));

            this._envelope = false;
            return callback(null, true);
        });
    }

    /**
     * 当与服务器的连接打开时运行的连接监听器
     *
     * @event
     */
    _onConnect() {
        clearTimeout(this._connectionTimeout);

        this.logger.info(
            {
                tnx: 'network',
                localAddress: this._socket.localAddress,
                localPort: this._socket.localPort,
                remoteAddress: this._socket.remoteAddress,
                remotePort: this._socket.remotePort
            },
            '%s 已建立到 %s:%s',
            this.secure ? '安全连接' : '连接',
            this._socket.remoteAddress,
            this._socket.remotePort
        );

        if (this._destroyed) {
            // 在我们已经取消连接后建立了连接
            this.close();
            return;
        }

        this.stage = 'connected';

        // 清除套接字的现有监听器
        this._socket.removeListener('data', this._onSocketData);
        this._socket.removeListener('timeout', this._onSocketTimeout);
        this._socket.removeListener('close', this._onSocketClose);
        this._socket.removeListener('end', this._onSocketEnd);

        this._socket.on('data', this._onSocketData);
        this._socket.once('close', this._onSocketClose);
        this._socket.once('end', this._onSocketEnd);

        this._socket.setTimeout(this.options.socketTimeout || SOCKET_TIMEOUT);
        this._socket.on('timeout', this._onSocketTimeout);

        this._greetingTimeout = setTimeout(() => {
            // 如果仍在等待问候消息，则放弃
            if (this._socket && !this._destroyed && this._responseActions[0] === this._actionGreeting)
                this._onError('从未收到问候消息', 'ETIMEDOUT', false, 'CONN');

        }, this.options.greetingTimeout || GREETING_TIMEOUT);

        this._responseActions.push(this._actionGreeting);

        // 我们已经设置了'data'监听器，所以如果套接字暂停则恢复它
        this._socket.resume();
    }

    /**
     * 从服务器接收数据的'data'监听器
     *
     * @event
     * @param {Buffer} chunk 从服务器来的数据块
     */
    _onData(chunk) {
        if (this._destroyed || !chunk || !chunk.length) return;

        let data = (chunk || '').toString('binary');
        let lines = (this._remainder + data).split(/\r?\n/);
        let lastline;

        this._remainder = lines.pop();

        for (let i = 0, len = lines.length; i < len; i++) {
            if (this._responseQueue.length) {
                lastline = this._responseQueue[this._responseQueue.length - 1];
                if (/^\d+-/.test(lastline.split('\n').pop())) {
                    this._responseQueue[this._responseQueue.length - 1] += '\n' + lines[i];
                    continue;
                }
            }
            this._responseQueue.push(lines[i]);
        }

        if (this._responseQueue.length) {
            lastline = this._responseQueue[this._responseQueue.length - 1];
            if (/^\d+-/.test(lastline.split('\n').pop())) return;
        }

        this._processResponse();
    }

    /**
     * 套接字的'error'监听器
     *
     * @event
     * @param {Error} err 错误对象
     * @param {String} type 错误名称
     */
    _onError(err, type, data, command) {
        clearTimeout(this._connectionTimeout);
        clearTimeout(this._greetingTimeout);
        // 如果连接已被销毁，则忽略错误
        if (this._destroyed) return;

        err = this._formatError(err, type, data, command);
        this.logger.error(data, err.message);
        this.emit('error', err);
        this.close();
    }

    _formatError(message, type, response, command) {
        let err;

        if (/Error\]$/i.test(Object.prototype.toString.call(message))) err = message;
        else err = new Error(message);

        if (type && type !== 'Error') err.code = type;

        if (response) {
            err.response = response;
            err.message += ': ' + response;
        }

        let responseCode = (typeof response === 'string' && Number((response.match(/^\d+/) || [])[0])) || false;
        if (responseCode) err.responseCode = responseCode;

        if (command) err.command = command;

        return err;
    }

    /**
     * 套接字的'close'监听器
     *
     * @event
     */
    _onClose() {
        let serverResponse = false;

        if (this._remainder && this._remainder.trim()) {
            if (this.options.debug || this.options.transactionLog) {
                this.logger.debug(
                    {
                        tnx: 'server'
                    },
                    this._remainder.replace(/\r?\n$/, '')
                );
            }
            this.lastServerResponse = serverResponse = this._remainder.trim();
        }

        this.logger.info(
            {
                tnx: 'network'
            },
            '连接已关闭'
        );

        if (this.upgrading && !this._destroyed)
            return this._onError(new Error('连接意外关闭'), 'ETLS', serverResponse, 'CONN');
        else if (![this._actionGreeting, this.close].includes(this._responseActions[0]) && !this._destroyed)
            return this._onError(new Error('连接意外关闭'), 'ECONNECTION', serverResponse, 'CONN');
        else if (/^[45]\d{2}\b/.test(serverResponse))
            return this._onError(new Error('连接意外关闭'), 'ECONNECTION', serverResponse, 'CONN');

        this._destroy();
    }

    /**
     * 套接字的'end'监听器
     *
     * @event
     */
    _onEnd() {
        if (this._socket && !this._socket.destroyed) this._socket.destroy();
    }

    /**
     * 套接字的'timeout'监听器
     *
     * @event
     */
    _onTimeout() {
        return this._onError(new Error('超时'), 'ETIMEDOUT', false, 'CONN');
    }

    /**
     * 销毁客户端，发出'end'事件
     */
    _destroy() {
        if (this._destroyed) return;
        this._destroyed = true;

        this.emit('end');
    }

    /**
     * 将连接升级到TLS
     *
     * @param {Function} callback 连接安全后运行的回调函数
     */
    _upgradeConnection(callback) {
        // 不要移除所有监听器，否则会破坏node v0.10，因为显然有一个'finish'事件设置也会被清除

        // 保留'error'、'end'、'close'等事件
        this._socket.removeListener('data', this._onSocketData); // 从此点开始传入的数据将是乱码
        this._socket.removeListener('timeout', this._onSocketTimeout); // 超时将被重新设置为新的套接字对象

        let socketPlain = this._socket;
        let opts = {
            socket: this._socket,
            host: this.host
        };

        Object.keys(this.options.tls || {}).forEach(key => {
            opts[key] = this.options.tls[key];
        });

        // 确保SNI的服务器名称
        if (this.servername && !opts.servername) opts.servername = this.servername;

        this.upgrading = true;
        // tls.connect不是异步函数，但它仍然可能抛出错误，需要使用try/catch包装
        try {
            this._socket = tls.connect(opts, () => {
                this.secure = true;
                this.upgrading = false;
                this._socket.on('data', this._onSocketData);

                socketPlain.removeListener('close', this._onSocketClose);
                socketPlain.removeListener('end', this._onSocketEnd);

                return callback(null, true);
            });
        } catch (err) {
            return callback(err);
        }

        this._socket.on('error', this._onSocketError);
        this._socket.once('close', this._onSocketClose);
        this._socket.once('end', this._onSocketEnd);

        this._socket.setTimeout(this.options.socketTimeout || SOCKET_TIMEOUT); // 10分钟
        this._socket.on('timeout', this._onSocketTimeout);

        // 如果套接字暂停，则恢复
        socketPlain.resume();
    }

    /**
     * 处理来自服务器的排队响应
     *
     * @param {Boolean} force 如果为true，忽略_processing标志
     */
    _processResponse() {
        if (!this._responseQueue.length) return false;

        let str = (this.lastServerResponse = (this._responseQueue.shift() || '').toString());
        if (/^\d+-/.test(str.split('\n').pop())) return; // 继续等待多行响应的最后部分

        if (this.options.debug || this.options.transactionLog) {
            this.logger.debug(
                {
                    tnx: 'server'
                },
                str.replace(/\r?\n$/, '')
            );
        }

        if (!str.trim()) setImmediate(() => this._processResponse());  // 跳过意外的空行

        let action = this._responseActions.shift();

        if (typeof action === 'function') {
            action.call(this, str);
            setImmediate(() => this._processResponse());
        }
        else return this._onError(new Error('意外响应'), 'EPROTOCOL', str, 'CONN');
    }

    /**
     * 向服务器发送命令，附加\r\n
     *
     * @param {String} str 要发送到服务器的字符串
     * @param {String} logStr 用于记录的可选字符串，而不是实际字符串
     */
    _sendCommand(str, logStr) {
        if (this._destroyed) return; // 连接已关闭，无法发送更多数据
        if (this._socket.destroyed) return this.close();

        if (this.options.debug || this.options.transactionLog)
            this.logger.debug(
                {
                    tnx: 'client'
                },
                (logStr || str || '').toString().replace(/\r?\n$/, '')
            );

        this._socket.write(Buffer.from(str + '\r\n', 'utf-8'));
    }

    /**
     * 通过提交信封数据来初始化新消息，以MAIL FROM:命令开始
     *
     * @param {Object} envelope 信封对象，形式为
     *        {from:'...', to:['...']}
     *        或
     *        {from:{address:'...',name:'...'}, to:[address:'...',name:'...']}
     */
    _setEnvelope(envelope, callback) {
        let args = [];
        let useSmtpUtf8 = false;

        this._envelope = envelope || {};
        this._envelope.from = ((this._envelope.from && this._envelope.from.address) || this._envelope.from || '').toString().trim();

        this._envelope.to = [].concat(this._envelope.to || []).map(to => ((to && to.address) || to || '').toString().trim());

        if (!this._envelope.to.length) return callback(this._formatError('未定义收件人', 'EENVELOPE', false, 'API'));

        if (this._envelope.from && /[\r\n<>]/.test(this._envelope.from))
            return callback(this._formatError('无效的发件人 ' + JSON.stringify(this._envelope.from), 'EENVELOPE', false, 'API'));

        // 检查发件人地址是否只使用ASCII字符，否则需要使用SMTPUTF8扩展
        if (/[\x80-\uFFFF]/.test(this._envelope.from)) useSmtpUtf8 = true;

        for (let i = 0, len = this._envelope.to.length; i < len; i++) {
            if (!this._envelope.to[i] || /[\r\n<>]/.test(this._envelope.to[i]))
                return callback(this._formatError('无效的收件人 ' + JSON.stringify(this._envelope.to[i]), 'EENVELOPE', false, 'API'));

            // 检查收件人地址是否只使用ASCII字符，否则需要使用SMTPUTF8扩展
            if (/[\x80-\uFFFF]/.test(this._envelope.to[i])) useSmtpUtf8 = true;
        }

        // 克隆收件人数组以供后续操作
        this._envelope.rcptQueue = JSON.parse(JSON.stringify(this._envelope.to || []));
        this._envelope.rejected = [];
        this._envelope.rejectedErrors = [];
        this._envelope.accepted = [];

        if (this._envelope.dsn) {
            try {
                this._envelope.dsn = this._setDsnEnvelope(this._envelope.dsn);
            } catch (err) {
                return callback(this._formatError('无效的DSN ' + err.message, 'EENVELOPE', false, 'API'));
            }
        }

        this._responseActions.push(str => {
            this._actionMAIL(str, callback);
        });

        // 如果服务器支持SMTPUTF8并且信封包含国际化电子邮件地址，则将SMTPUTF8关键字附加到MAIL FROM命令
        if (useSmtpUtf8 && this._supportedExtensions.includes('SMTPUTF8')) {
            args.push('SMTPUTF8');
            this._usingSmtpUtf8 = true;
        }

        // 如果服务器支持8BITMIME并且消息可能包含非ASCII字节,则将8BITMIME关键字附加到MAIL FROM命令
        if (this._envelope.use8BitMime && this._supportedExtensions.includes('8BITMIME')) {
            args.push('BODY=8BITMIME');
            this._using8BitMime = true;
        }

        if (this._envelope.size && this._supportedExtensions.includes('SIZE')) args.push('SIZE=' + this._envelope.size);

        // 如果服务器支持DSN并且信封包含DSN属性,则将DSN参数附加到MAIL FROM命令
        if (this._envelope.dsn && this._supportedExtensions.includes('DSN')) {
            if (this._envelope.dsn.ret) args.push('RET=' + encodeXText(this._envelope.dsn.ret));
            if (this._envelope.dsn.envid) args.push('ENVID=' + encodeXText(this._envelope.dsn.envid));
        }

        this._sendCommand('MAIL FROM:<' + this._envelope.from + '>' + (args.length ? ' ' + args.join(' ') : ''));
    }

    _setDsnEnvelope(params) {
        let ret = (params.ret || params.return || '').toString().toUpperCase() || null;
        if (ret) {
            switch (ret) {
                case 'HDRS':
                case 'HEADERS':
                    ret = 'HDRS';
                    break;
                case 'FULL':
                case 'BODY':
                    ret = 'FULL';
                    break;
            }
        }

        if (ret && !['FULL', 'HDRS'].includes(ret)) throw new Error('ret: ' + JSON.stringify(ret));

        let envid = (params.envid || params.id || '').toString() || null;

        let notify = params.notify || null;
        if (notify) {
            if (typeof notify === 'string') notify = notify.split(',');

            notify = notify.map(n => n.trim().toUpperCase());
            let validNotify = ['NEVER', 'SUCCESS', 'FAILURE', 'DELAY'];
            let invaliNotify = notify.filter(n => !validNotify.includes(n));
            if (invaliNotify.length || (notify.length > 1 && notify.includes('NEVER')))
                throw new Error('notify: ' + JSON.stringify(notify.join(',')));
            notify = notify.join(',');
        }

        let orcpt = (params.recipient || params.orcpt || '').toString() || null;
        if (orcpt && orcpt.indexOf(';') < 0) {
            orcpt = 'rfc822;' + orcpt;
        }

        return { ret, envid, notify, orcpt };
    }

    _getDsnRcptToArgs() {
        let args = [];
        // 如果服务器支持DSN并且信封包含DSN属性,则将DSN参数附加到RCPT TO命令
        if (this._envelope.dsn && this._supportedExtensions.includes('DSN')) {
            if (this._envelope.dsn.notify) args.push('NOTIFY=' + encodeXText(this._envelope.dsn.notify));
            if (this._envelope.dsn.orcpt) args.push('ORCPT=' + encodeXText(this._envelope.dsn.orcpt));
        }
        return args.length ? ' ' + args.join(' ') : '';
    }

    _createSendStream(callback) {
        let dataStream = new DataStream();
        let logStream;

        if (this.options.lmtp)
            this._envelope.accepted.forEach((recipient, i) => {
                let final = i === this._envelope.accepted.length - 1;
                this._responseActions.push(str => {
                    this._actionLMTPStream(recipient, final, str, callback);
                });
            });
        else
            this._responseActions.push(str => {
                this._actionSMTPStream(str, callback);
            });

        dataStream.pipe(this._socket, {
            end: false
        });

        if (this.options.debug) {
            logStream = new PassThrough();
            logStream.on('readable', () => {
                let chunk;
                while ((chunk = logStream.read())) {
                    this.logger.debug(
                        {
                            tnx: 'message'
                        },
                        chunk.toString('binary').replace(/\r?\n$/, '')
                    );
                }
            });
            dataStream.pipe(logStream);
        }

        dataStream.once('end', () => {
            this.logger.info(
                {
                    tnx: 'message',
                    inByteCount: dataStream.inByteCount,
                    outByteCount: dataStream.outByteCount
                },
                '<%s bytes encoded mime message (source size %s bytes)>',
                dataStream.outByteCount,
                dataStream.inByteCount
            );
        });

        return dataStream;
    }

    /** 动作处理函数 **/

    /**
     * 在连接创建后且服务器发送问候消息后运行。
     * 如果传入消息以220开头，则通过发送EHLO命令启动SMTP会话
     *
     * @param {String} str 来自服务器的消息
     */
    _actionGreeting(str) {
        clearTimeout(this._greetingTimeout);

        if (str.substring(0, 3) !== '220') {
            this._onError(new Error('无效的问候。响应=' + str), 'EPROTOCOL', str, 'CONN');
            return;
        }

        if (this.options.lmtp) {
            this._responseActions.push(this._actionLHLO);
            this._sendCommand('LHLO ' + this.name);
        } else {
            this._responseActions.push(this._actionEHLO);
            this._sendCommand('EHLO ' + this.name);
        }
    }

    /**
     * 处理LHLO命令的服务器响应。如果产生错误，
     * 发出'error'，否则将其视为EHLO响应
     *
     * @param {String} str 来自服务器的消息
     */
    _actionLHLO(str) {
        if (str.charAt(0) !== '2') {
            this._onError(new Error('无效的LHLO。响应=' + str), 'EPROTOCOL', str, 'LHLO');
            return;
        }

        this._actionEHLO(str);
    }

    /**
     * 处理EHLO命令的服务器响应。如果产生错误，
     * 尝试改用HELO，否则如果服务器支持STARTTLS
     * 则启动TLS协商，或进入认证阶段。
     *
     * @param {String} str 来自服务器的消息
     */
    _actionEHLO(str) {
        let match;

        if (str.substring(0, 3) === '421') {
            this._onError(new Error('服务器终止连接。响应=' + str), 'ECONNECTION', str, 'EHLO');
            return;
        }

        if (str.charAt(0) !== '2') {
            if (this.options.requireTLS) {
                this._onError(new Error('EHLO失败但HELO不支持必需的STARTTLS。响应=' + str), 'ECONNECTION', str, 'EHLO');
                return;
            }

            // 尝试改用HELO
            this._responseActions.push(this._actionHELO);
            this._sendCommand('HELO ' + this.name);
            return;
        }

        this._ehloLines = str
            .split(/\r?\n/)
            .map(line => line.replace(/^\d+[ -]/, '').trim())
            .filter(line => line)
            .slice(1);

        // 检测服务器是否支持STARTTLS
        if (!this.secure && !this.options.ignoreTLS && (REGEX_STARTTLS.test(str) || this.options.requireTLS)) {
            this._sendCommand('STARTTLS');
            this._responseActions.push(this._actionSTARTTLS);
            return;
        }

        // 检测服务器是否支持SMTPUTF8
        if (REGEX_SMTPUTF8.test(str)) this._supportedExtensions.push('SMTPUTF8');

        // 检测服务器是否支持DSN
        if (REGEX_DSN.test(str)) this._supportedExtensions.push('DSN');

        // 检测服务器是否支持8BITMIME
        if (REGEX_8BITMIME.test(str)) this._supportedExtensions.push('8BITMIME');

        // 检测服务器是否支持PIPELINING
        if (REGEX_PIPELINING.test(str)) this._supportedExtensions.push('PIPELINING');

        // 检测服务器是否支持AUTH
        if (REGEX_AUTH.test(str)) this.allowsAuth = true;

        // 检测服务器是否支持PLAIN认证
        if (new RegExp(REGEX_AUTH_MECHANISM.source + 'PLAIN', 'i').test(str)) this._supportedAuth.push('PLAIN');

        // 检测服务器是否支持LOGIN认证
        if (new RegExp(REGEX_AUTH_MECHANISM.source + 'LOGIN', 'i').test(str)) this._supportedAuth.push('LOGIN');

        // 检测服务器是否支持CRAM-MD5认证
        if (new RegExp(REGEX_AUTH_MECHANISM.source + 'CRAM-MD5', 'i').test(str)) this._supportedAuth.push('CRAM-MD5');

        // 检测服务器是否支持XOAUTH2认证
        if (new RegExp(REGEX_AUTH_MECHANISM.source + 'XOAUTH2', 'i').test(str)) this._supportedAuth.push('XOAUTH2');

        // 检测服务器是否支持SIZE扩展（以及最大允许大小）
        if ((match = str.match(REGEX_SIZE))) {
            this._supportedExtensions.push('SIZE');
            this._maxAllowedSize = Number(match[1]) || 0;
        }

        this.emit('connect');
    }

    /**
     * 处理HELO命令的服务器响应。如果产生错误，
     * 发出'error'，否则进入认证阶段。
     *
     * @param {String} str 来自服务器的消息
     */
    _actionHELO(str) {
        if (str.charAt(0) !== '2') {
            this._onError(new Error('无效的HELO。响应=' + str), 'EPROTOCOL', str, 'HELO');
            return;
        }

        // 假设认证已启用（尽管很可能没有）
        this.allowsAuth = true;

        this.emit('connect');
    }

    /**
     * 处理STARTTLS命令的服务器响应。如果有错误
     * 尝试改用HELO，否则启动TLS升级。如果升级
     * 成功，重新启动EHLO
     *
     * @param {String} str 来自服务器的消息
     */
    _actionSTARTTLS(str) {
        if (str.charAt(0) !== '2') {
            if (this.options.opportunisticTLS) {
                this.logger.info(
                    {
                        tnx: 'smtp'
                    },
                    'STARTTLS升级失败，继续未加密'
                );
                return this.emit('connect');
            }
            this._onError(new Error('使用STARTTLS升级连接时出错'), 'ETLS', str, 'STARTTLS');
            return;
        }

        this._upgradeConnection((err, secured) => {
            if (err) {
                this._onError(new Error('启动TLS错误 - ' + (err.message || err)), 'ETLS', false, 'STARTTLS');
                return;
            }

            this.logger.info(
                {
                    tnx: 'smtp'
                },
                '连接已使用STARTTLS升级'
            );

            if (secured) {
                // 重新启动会话
                if (this.options.lmtp) {
                    this._responseActions.push(this._actionLHLO);
                    this._sendCommand('LHLO ' + this.name);
                } else {
                    this._responseActions.push(this._actionEHLO);
                    this._sendCommand('EHLO ' + this.name);
                }
            }
            else this.emit('connect');
        });
    }

    /**
     * 处理AUTH LOGIN命令的响应。我们期望
     * '334 VXNlcm5hbWU6'（'Username:'的base64编码）。作为
     * 响应发送的数据需要是base64编码的用户名。我们不需要
     * 精确匹配，但通常使用334响应，因为某些
     * 主机无效地使用比VXNlcm5hbWU6更长的消息
     *
     * @param {String} str 来自服务器的消息
     */
    _actionAUTH_LOGIN_USER(str, callback) {
        if (!/^334[ -]/.test(str)) {
            // 期望 '334 VXNlcm5hbWU6'
            callback(this._formatError('在等待"334 VXNlcm5hbWU6"时登录序列无效', 'EAUTH', str, 'AUTH LOGIN'));
            return;
        }

        this._responseActions.push(str => {
            this._actionAUTH_LOGIN_PASS(str, callback);
        });

        this._sendCommand(Buffer.from(this._auth.credentials.user + '', 'utf-8').toString('base64'));
    }

    /**
     * 处理AUTH CRAM-MD5命令的响应。我们期望
     * '334 <challenge string>'。作为响应发送的数据需要是
     * base64解码的挑战字符串，使用密码作为HMAC密钥进行MD5哈希，
     * 前缀为用户名和空格，最后再次全部base64编码。
     *
     * @param {String} str 来自服务器的消息
     */
    _actionAUTH_CRAM_MD5(str, callback) {
        let challengeMatch = str.match(/^334\s+(.+)$/);
        let challengeString = '';
        if (!challengeMatch)
            return callback(this._formatError('在等待服务器挑战字符串时登录序列无效', 'EAUTH', str, 'AUTH CRAM-MD5'));
        else challengeString = challengeMatch[1];

        // 从base64解码
        let base64decoded = Buffer.from(challengeString, 'base64').toString('ascii'),
            hmacMD5 = createHmac('md5', this._auth.credentials.pass);

        hmacMD5.update(base64decoded);

        let prepended = this._auth.credentials.user + ' ' + hmacMD5.digest('hex');

        this._responseActions.push(str => {
            this._actionAUTH_CRAM_MD5_PASS(str, callback);
        });

        this._sendCommand(
            Buffer.from(prepended).toString('base64'),
            // 日志中的隐藏哈希
            Buffer.from(this._auth.credentials.user + ' /* secret */').toString('base64')
        );
    }

    /**
     * 处理CRAM-MD5认证的响应，如果没有错误，
     * 用户可以视为已登录。开始等待要发送的消息
     *
     * @param {String} str 来自服务器的消息
     */
    _actionAUTH_CRAM_MD5_PASS(str, callback) {
        if (!str.match(/^235\s+/)) return callback(this._formatError('在等待"235"时登录序列无效', 'EAUTH', str, 'AUTH CRAM-MD5'));

        this.logger.info(
            {
                tnx: 'smtp',
                username: this._auth.user,
                action: 'authenticated',
                method: this._authMethod
            },
            '用户 %s 已认证',
            JSON.stringify(this._auth.user)
        );
        this.authenticated = true;
        callback(null, true);
    }

    /**
     * 处理AUTH LOGIN命令的响应。我们期望
     * '334 UGFzc3dvcmQ6'（'Password:'的base64编码）。作为
     * 响应发送的数据需要是base64编码的密码。
     *
     * @param {String} str 来自服务器的消息
     */
    _actionAUTH_LOGIN_PASS(str, callback) {
        // 期望 '334 UGFzc3dvcmQ6'
        if (!/^334[ -]/.test(str))
            return callback(this._formatError('在等待"334 UGFzc3dvcmQ6"时登录序列无效', 'EAUTH', str, 'AUTH LOGIN'));

        this._responseActions.push(str => {
            this._actionAUTHComplete(str, callback);
        });

        this._sendCommand(
            Buffer.from((this._auth.credentials.pass || '').toString(), 'utf-8').toString('base64'),
            // 日志中的隐藏密码
            Buffer.from('/* secret */', 'utf-8').toString('base64')
        );
    }

    /**
     * 处理认证的响应，如果没有错误，
     * 用户可以视为已登录。开始等待要发送的消息
     *
     * @param {String} str 来自服务器的消息
     */
    _actionAUTHComplete(str, isRetry, callback) {
        if (!callback && typeof isRetry === 'function') {
            callback = isRetry;
            isRetry = false;
        }

        if (str.substring(0, 3) === '334') {
            this._responseActions.push(str => {
                if (isRetry || this._authMethod !== 'XOAUTH2') this._actionAUTHComplete(str, true, callback);
                else setImmediate(() => this._handleXOauth2Token(true, callback));  // 获取新的OAuth2访问令牌
            });
            this._sendCommand('');
            return;
        }

        if (str.charAt(0) !== '2') {
            this.logger.info(
                {
                    tnx: 'smtp',
                    username: this._auth.user,
                    action: 'authfail',
                    method: this._authMethod
                },
                '用户 %s 认证失败',
                JSON.stringify(this._auth.user)
            );
            return callback(this._formatError('无效的登录', 'EAUTH', str, 'AUTH ' + this._authMethod));
        }

        this.logger.info(
            {
                tnx: 'smtp',
                username: this._auth.user,
                action: 'authenticated',
                method: this._authMethod
            },
            '用户 %s 已认证',
            JSON.stringify(this._auth.user)
        );
        this.authenticated = true;
        callback(null, true);
    }

    /**
     * 处理MAIL FROM:命令的响应
     *
     * @param {String} str 来自服务器的消息
     */
    _actionMAIL(str, callback) {
        let message, curRecipient;
        if (Number(str.charAt(0)) !== 2) {
            if (this._usingSmtpUtf8 && /^550 /.test(str) && /[\x80-\uFFFF]/.test(this._envelope.from))
                message = '不允许国际化的邮箱名称';
            else message = '邮件命令失败';

            return callback(this._formatError(message, 'EENVELOPE', str, 'MAIL FROM'));
        }

        if (!this._envelope.rcptQueue.length)
            return callback(this._formatError("无法发送邮件 - 未定义收件人", 'EENVELOPE', false, 'API'));
        else {
            this._recipientQueue = [];

            const processRecipient = (recipient) => {
                this._recipientQueue.push(recipient);
                this._responseActions.push(str => {
                    this._actionRCPT(str, callback);
                });
                this._sendCommand('RCPT TO:<' + recipient + '>' + this._getDsnRcptToArgs());
            };

            if (this._supportedExtensions.includes('PIPELINING'))
                // 流水线模式：一次性发送所有收件人
                while (this._envelope.rcptQueue.length) {
                    const curRecipient = this._envelope.rcptQueue.shift();
                    processRecipient(curRecipient);
                }
            else {
                // 非流水线模式：逐个发送收件人
                const curRecipient = this._envelope.rcptQueue.shift();
                processRecipient(curRecipient);
            }
        }
    }

    /**
     * 处理RCPT TO:命令的响应
     *
     * @param {String} str 来自服务器的消息
     */
    _actionRCPT(str, callback) {
        let message,
            err,
            curRecipient = this._recipientQueue.shift();
        if (Number(str.charAt(0)) !== 2) {
            // 这是一个软错误
            if (this._usingSmtpUtf8 && /^553 /.test(str) && /[\x80-\uFFFF]/.test(curRecipient)) message = '不允许国际化的邮箱名称';
            else message = '收件人命令失败';

            this._envelope.rejected.push(curRecipient);
            // 为失败的收件人存储错误
            err = this._formatError(message, 'EENVELOPE', str, 'RCPT TO');
            err.recipient = curRecipient;
            this._envelope.rejectedErrors.push(err);
        }
        else this._envelope.accepted.push(curRecipient);

        if (!this._envelope.rcptQueue.length && !this._recipientQueue.length) {
            if (this._envelope.rejected.length < this._envelope.to.length) {
                this._responseActions.push(str => {
                    this._actionDATA(str, callback);
                });
                this._sendCommand('DATA');
            } else {
                err = this._formatError("无法发送邮件 - 所有收件人都被拒绝", 'EENVELOPE', str, 'RCPT TO');
                err.rejected = this._envelope.rejected;
                err.rejectedErrors = this._envelope.rejectedErrors;
                return callback(err);
            }
        } else if (this._envelope.rcptQueue.length) {
            curRecipient = this._envelope.rcptQueue.shift();
            this._recipientQueue.push(curRecipient);
            this._responseActions.push(str => {
                this._actionRCPT(str, callback);
            });
            this._sendCommand('RCPT TO:<' + curRecipient + '>' + this._getDsnRcptToArgs());
        }
    }

    /**
     * 处理DATA命令的响应
     *
     * @param {String} str 来自服务器的消息
     */
    _actionDATA(str, callback) {
        // 如果不是23，则数据命令失败
        if (!/^[23]/.test(str)) return callback(this._formatError('数据命令失败', 'EENVELOPE', str, 'DATA'));

        let response = {
            accepted: this._envelope.accepted,
            rejected: this._envelope.rejected
        };

        if (this._ehloLines && this._ehloLines.length) response.ehlo = this._ehloLines;
        if (this._envelope.rejectedErrors.length) response.rejectedErrors = this._envelope.rejectedErrors;

        callback(null, response);
    }

    /**
     * 使用SMTP时处理DATA流的响应
     * 我们期望一个单独的响应来定义发送是否成功或失败
     *
     * @param {String} str 来自服务器的消息
     */
    _actionSMTPStream(str, callback) {
        if (Number(str.charAt(0)) !== 2) return callback(this._formatError('消息失败', 'EMESSAGE', str, 'DATA'));  // 消息失败
        else return callback(null, str);  // 消息成功发送
    }

    /**
     * 处理DATA流的响应
     * 我们期望每个收件人有一个单独的响应。所有收件人可以
     * 分别成功或失败
     *
     * @param {String} recipient 此响应适用的收件人
     * @param {Boolean} final 这是最后一个收件人吗？
     * @param {String} str 来自服务器的消息
     */
    _actionLMTPStream(recipient, final, str, callback) {
        let err;
        if (Number(str.charAt(0)) !== 2) {
            // 消息失败
            err = this._formatError('收件人 ' + recipient + ' 的消息失败', 'EMESSAGE', str, 'DATA');
            err.recipient = recipient;
            this._envelope.rejected.push(recipient);
            this._envelope.rejectedErrors.push(err);
            for (let i = 0, len = this._envelope.accepted.length; i < len; i++) {
                if (this._envelope.accepted[i] === recipient) this._envelope.accepted.splice(i, 1);
            }
        }
        if (final) return callback(null, str);
    }

    _handleXOauth2Token(isRetry, callback) {
        this._auth.oauth2.getToken(isRetry, (err, accessToken) => {
            if (err) {
                this.logger.info(
                    {
                        tnx: 'smtp',
                        username: this._auth.user,
                        action: 'authfail',
                        method: this._authMethod
                    },
                    '用户 %s 认证失败',
                    JSON.stringify(this._auth.user)
                );
                return callback(this._formatError(err, 'EAUTH', false, 'AUTH XOAUTH2'));
            }
            this._responseActions.push(str => {
                this._actionAUTHComplete(str, isRetry, callback);
            });
            this._sendCommand(
                'AUTH XOAUTH2 ' + this._auth.oauth2.buildXOAuth2Token(accessToken),
                // 日志中的隐藏信息
                'AUTH XOAUTH2 ' + this._auth.oauth2.buildXOAuth2Token('/* secret */')
            );
        });
    }

    /**
     *
     * @param {string} command
     * @private
     */
    _isDestroyedMessage(command) {
        if (this._destroyed) return '无法 ' + command + ' - SMTP连接已销毁。';

        if (this._socket) {
            if (this._socket.destroyed) return '无法 ' + command + ' - SMTP连接套接字已销毁。';
            if (!this._socket.writable) return '无法 ' + command + ' - SMTP连接套接字已半关闭。';
        }
    }

    _getHostname() {
        // 默认主机名是机器主机名或[IP]
        let defaultHostname;
        try {
            defaultHostname = os.hostname() || '';
        } catch (err) {
            defaultHostname = 'localhost'; // 在Windows 7上失败
        }

        // 如果不是FQDN则忽略
        if (!defaultHostname || defaultHostname.indexOf('.') < 0) defaultHostname = '[127.0.0.1]';
        // IP地址应包含在[]中
        if (defaultHostname.match(/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/)) defaultHostname = '[' + defaultHostname + ']';

        return defaultHostname;
    }
}

module.exports = SmtpConnection;