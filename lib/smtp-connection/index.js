'use strict';

// 导入依赖包
const NET = require('net');
const TLS = require('tls');
const OS = require('os');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const { randomBytes, createHmac } = require('crypto');
const packageInfo = require('../../package.json');
const { regexs, resetRegex } = require('../regexs');
const DataStream = require('./data-stream');
const { getLogger, resolveHostname, callbackPromise, encodeXText } = require('../shared');

// 默认超时时间（毫秒）
const CONNECTION_TIMEOUT = 2 * 60 * 1000; // 连接建立超时时间
const SOCKET_TIMEOUT = 10 * 60 * 1000; // 套接字无活动超时时间
const GREETING_TIMEOUT = 30 * 1000; // 连接建立后等待SMTP问候消息的超时时间
const DNS_TIMEOUT = 30 * 1000; // DNS解析超时时间

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
    constructor(options = {}) {
        super(options);

        // 生成随机连接ID
        resetRegex(regexs.URL_SAFE_BASE64);
        this.id = randomBytes(8).toString('base64').replace(regexs.URL_SAFE_BASE64, '');
        this.stage = 'init';
        this.options = options;
        this.secureConnection = !!this.options.secure;
        this.alreadySecured = !!this.options.secured;
        this.port = Number(this.options.port) || (this.secureConnection ? 465 : 587);
        this.host = this.options.host || 'localhost';
        this.servername = this.options.servername ? this.options.servername : !NET.isIP(this.host) ? this.host : false;
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

        this.secure = !!this.secureConnection;  // 定义当前连接是否安全。如果不安全，如果服务器支持，可以使用STARTTLS
        this.version = packageInfo.version;     // 暴露版本号
        this._remainder = '';                   // 存储来自服务器的不完整消息
        this._maxAllowedSize = 0;               // 定义单个消息允许的最大大小
        this._supportedExtensions = [];         // 列出支持的扩展列表
        this._responseActions = [];             // 当从服务器接收到数据块时要运行的函数队列
        this._recipientQueue = [];              // 这个队列包含要发送的收件人列表
        this._responseQueue = [];               // 来自服务器的未处理响应队列
        this._supportedAuth = [];               // 列出支持的认证机制列表
        this._socket = false;                   // 连接到服务器的套接字,如果没有套接字，则为false
        this._closing = false;                  // 如果套接字正在关闭，则设置为true
        this._envelope = false;                 // 包含当前信封（发件人，收件人）的对象,如果没有信封，则为false
        this._destroyed = false;                // 如果套接字被认为已关闭，则设置为true
        this._greetingTimeout = false;          // 等待问候消息的超时变量,如果为true，则表示已超时
        this._connectionTimeout = false;        // 等待连接开始的超时变量,如果为true，则表示已超时
        this.destroyed = false;                 // 如果设置为true，此实例不再活跃
        this.allowsAuth = false;                // 如果EHLO响应包含"AUTH"，则设置为true。如果为false，则不尝试认证
        this.authenticated = false;             // 如果为true，则表示用户已认证
        this.lastServerResponse = false;        // 最后的服务器响应,如果没有响应，则为false

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

            const destroyedMsg = this._isDestroyedMessage('connect');
            if (destroyedMsg) return connectCallback(this._formatError(destroyedMsg, 'ECONNECTION', false, 'CONN'));
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

            if (this.secureConnection && !this.alreadySecured)
                setImmediate(() =>
                    this._upgradeConnection(err => {
                        if (err) return this._onError(new Error('启动TLS错误 - ' + (err.message || err)), 'ETLS', false, 'CONN');
                        this._onConnect();
                    })
                );
            else setImmediate(() => this._onConnect());

            return;
        }

        // 提取创建连接逻辑
        const createConnection = (connectionCreator) => {
            return this._resolveAndConnect(opts, (resolvedOpts) => {
                this._socket = connectionCreator(resolvedOpts);
                this._socket.setKeepAlive(true);
                this._socket.once('connect', () => this._onConnect());
            });
        };
        const { socket, tls } = this.options;
        // 如果套接字已设置，则使用它
        if (socket)
            return createConnection((resolvedOpts) => {
                socket.connect(this.port, this.host, () => { });
                return socket;
            });
        // 如果secureConnection为true，则使用TLS连接
        else if (this.secureConnection) {
            if (tls) Object.keys(tls).forEach(key => { opts[key] = tls[key]; })
            // 确保SNI的服务器名称
            if (this.servername && !opts.servername) opts.servername = this.servername;

            return createConnection((resolvedOpts) => TLS.connect(resolvedOpts));
        }
        // 否则,则使用明文连接
        else return createConnection((resolvedOpts) => NET.connect(resolvedOpts));
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
        if (this._closing) return; this._closing = true;

        const closeMethod = this.stage === 'init' ? 'destroy' : 'end'; // 连接超时时立即关闭套接字
        this.logger.debug(
            {
                tnx: 'smtp'
            },
            '使用"%s"关闭与服务器的连接',
            closeMethod
        );

        let socket = this._socket?.socket || this._socket;
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
        const credentials = includePassword ? this._auth.credentials.pass : '/* secret */';
        return Buffer.from('\u0000' + this._auth.credentials.user + '\u0000' + credentials, 'utf-8').toString('base64');
    }

    /**
     * 用户认证
     */
    login(authData = {}, callback) {
        const destroyedMsg = this._isDestroyedMessage('login');
        if (destroyedMsg) return callback(this._formatError(destroyedMsg, 'ECONNECTION', false, 'API'));

        this._auth = authData;
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
                if (returned) return; returned = true;
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
                if (returned) return; returned = true;
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

                        let codes = str.match(regexs.RESPONSE_CODE);
                        let data = { command: cmd, response: str };
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
                return this._actionAUTH_XOAUTH2_TOKEN(false, callback);
            case 'LOGIN':
                this._responseActions.push(str => { this._actionAUTH_LOGIN_USER(str, callback); });
                this._sendCommand('AUTH LOGIN');
                return;
            case 'PLAIN':
                this._responseActions.push(str => { this._actionAUTH_PLAIN_RESPONSE(str, callback); });
                this._sendCommand(
                    'AUTH PLAIN ' + this._generateAuthPlainString(true),  // 认证参数
                    'AUTH PLAIN ' + this._generateAuthPlainString(false)  // 日志参数:日志条目不包含密码
                );
                return;
            case 'CRAM-MD5':
                this._responseActions.push(str => { this._actionAUTH_CRAM_MD5(str, callback); });
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

        const destroyedMsg = this._isDestroyedMessage('send message');
        if (destroyedMsg) return done(this._formatError(destroyedMsg, 'ECONNECTION', false, 'API'));

        // 拒绝大于允许大小的消息
        if (this._maxAllowedSize && envelope.size > this._maxAllowedSize)
            return setImmediate(() => {
                done(this._formatError('消息大小超过允许值 ' + this._maxAllowedSize, 'EMESSAGE', false, 'MAIL FROM'));
            });

        // 确保回调只被调用一次
        let returned = false;
        let callback = function () {
            if (returned) return; returned = true;
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
        if (this._destroyed) return this.close(); // 如果连接已销毁，则关闭连接

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
        this._socket.resume();
    }

    /**
     * 从服务器接收数据的'data'监听器
     *
     * @event
     * @param {Buffer} chunk 从服务器来的数据块
     */
    _onData(chunk) {
        if (this._destroyed || !chunk?.length) return;
        let data = chunk.toString('latin1');

        // 拼接剩余数据并分割行
        const lines = (this._remainder + data).split(regexs.HEADER_LINE_BREAK);
        this._remainder = lines.pop(); // 保存不完整的行

        let lastline = this._responseQueue.at(-1) ?? null;
        for (let i = 0, len = lines.length; i < len; i++) {
            const line = lines[i];
            // 检查是否需要延续（确保 lastline 存在）
            if (lastline && regexs.CONTINUATION_RESPONSE.test(lastline.split('\n').pop())) {
                lastline += '\n' + line;
                this._responseQueue[this._responseQueue.length - 1] = lastline;
            } else {
                this._responseQueue.push(line); // 新响应：推入队列并更新 lastline
                lastline = line;
            }
        }

        // 如果响应未完成，等待后续数据
        if (lastline && regexs.CONTINUATION_RESPONSE.test(lastline.split('\n').pop())) return;
        this._processResponse(); // 处理完整响应
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
        if (this._destroyed) return;  // 如果连接已被销毁，则忽略错误

        err = this._formatError(err, type, data, command);
        this.logger.error(data, err.message);
        this.emit('error', err);
        this.close();
    }

    _formatError(message, type, response, command) {
        let err;
        if (regexs.ERROR_SUFFIX.test(Object.prototype.toString.call(message))) err = message;
        else err = new Error(message);

        if (type && type !== 'Error') err.code = type;
        if (response) {
            err.response = response;
            err.message += ': ' + response;
        }

        let responseCode = (typeof response === 'string' && parseInt(response)) || false;
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
                    this._remainder.replace(regexs.OPTIONAL_CRLF, '')
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

        if (this.upgrading && !this._destroyed) return this._onError(new Error('连接意外关闭'), 'ETLS', serverResponse, 'CONN');
        else if ((![this._actionGreeting, this.close].includes(this._responseActions[0]) && !this._destroyed) ||
            regexs.RESPONSE_4XX_5XX.test(serverResponse))
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
        if (this._destroyed) return; this._destroyed = true;
        this.emit('end');
    }

    /**
     * 将连接升级到TLS
     *
     * @param {Function} callback 连接安全后运行的回调函数
     */
    _upgradeConnection(callback) {
        // 定义原始socket,移除相关监听,保留'error'、'end'、'close'等事件
        const socketPlain = this._socket;
        this._socket.removeListener('data', this._onSocketData);
        this._socket.removeListener('timeout', this._onSocketTimeout);

        let opts = {
            socket: socketPlain,
            host: this.host,
            ...(this.options.tls || {}), // 直接合并TLS选项
        };

        // 确保SNI的服务器名称
        if (this.servername && !opts.servername) opts.servername = this.servername;
        this.upgrading = true;
        try {
            const tlsSocket = TLS.connect(opts, () => {
                this.secure = true;
                this.upgrading = false;
                tlsSocket.on('data', this._onSocketData);
                // 清理旧socket的事件剩余监听器
                socketPlain.removeListener('error', this._onSocketError);
                socketPlain.removeListener('close', this._onSocketClose);
                socketPlain.removeListener('end', this._onSocketEnd);
                return callback(null, true);
            });
            // 更新实例socket引用,并绑定新socket的事件处理器
            this._socket = tlsSocket;
            tlsSocket.on('error', this._onSocketError);
            tlsSocket.once('close', this._onSocketClose);
            tlsSocket.once('end', this._onSocketEnd);
            tlsSocket.setTimeout(this.options.socketTimeout || SOCKET_TIMEOUT);
            tlsSocket.on('timeout', this._onSocketTimeout);
        } catch (err) {
            this.upgrading = false;
            return callback(err);
        }
        socketPlain.resume();  // 如果套接字暂停，则恢复
    }

    /**
     * 处理来自服务器的排队响应
     *
     * @param {Boolean} force 如果为true，忽略_processing标志
     */
    _processResponse() {
        if (!this._responseQueue.length) return false;

        let str = (this.lastServerResponse = (this._responseQueue.shift() || '').toString());
        if (regexs.CONTINUATION_RESPONSE.test(str.split('\n').pop())) return; // 继续等待多行响应的最后部分

        if (this.options.debug || this.options.transactionLog) {
            this.logger.debug(
                {
                    tnx: 'server'
                },
                str.replace(regexs.OPTIONAL_CRLF, '')
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
                (logStr || str || '').toString().replace(regexs.OPTIONAL_CRLF, '')
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
    _setEnvelope(envelope = {}, callback) {
        let args = [], useSmtpUtf8 = false;

        this._envelope = envelope;
        let { from, to, dsn, use8BitMime, size } = this._envelope;
        this._envelope.from = from = ((from?.address) || from || '').toString().trim();
        this._envelope.to = to = [].concat(to || []).map(to => ((to?.address) || to || '').toString().trim());

        if (!to.length) return callback(this._formatError('未定义收件人', 'EENVELOPE', false, 'API'));
        if (from && regexs.INVALID_ADDRESS_CHARS.test(from))
            return callback(this._formatError('无效的发件人 ' + JSON.stringify(from), 'EENVELOPE', false, 'API'));

        // 检查发件人地址是否只使用ASCII字符，否则需要使用SMTPUTF8扩展
        if (regexs.NON_ASCII.test(from)) useSmtpUtf8 = true;

        for (let i = 0; i < to.length; i++) {
            if (!to[i] || regexs.INVALID_ADDRESS_CHARS.test(to[i]))
                return callback(this._formatError('无效的收件人 ' + JSON.stringify(to[i]), 'EENVELOPE', false, 'API'));

            // 检查收件人地址是否只使用ASCII字符，否则需要使用SMTPUTF8扩展
            if (regexs.NON_ASCII.test(to[i])) useSmtpUtf8 = true;
        }

        // 克隆收件人数组以供后续操作
        this._envelope.rcptQueue = [...to];
        this._envelope.rejected = [];
        this._envelope.rejectedErrors = [];
        this._envelope.accepted = [];

        if (dsn) {
            try {
                this._envelope.dsn = dsn = this._setDsnEnvelope(dsn);
            } catch (err) {
                return callback(this._formatError('无效的DSN ' + err.message, 'EENVELOPE', false, 'API'));
            }
        }

        this._responseActions.push(str => { this._actionMAIL(str, callback); });

        // 如果服务器支持SMTPUTF8并且信封包含国际化电子邮件地址，则将SMTPUTF8关键字附加到MAIL FROM命令
        if (useSmtpUtf8 && this._supportedExtensions.includes('SMTPUTF8')) {
            args.push('SMTPUTF8');
            this._usingSmtpUtf8 = true;
        }

        // 如果服务器支持8BITMIME并且消息可能包含非ASCII字节,则将8BITMIME关键字附加到MAIL FROM命令
        if (use8BitMime && this._supportedExtensions.includes('8BITMIME')) {
            args.push('BODY=8BITMIME');
            this._using8BitMime = true;
        }

        if (size && this._supportedExtensions.includes('SIZE')) args.push('SIZE=' + size);

        // 如果服务器支持DSN并且信封包含DSN属性,则将DSN参数附加到MAIL FROM命令
        if (dsn && this._supportedExtensions.includes('DSN')) {
            if (dsn.ret) args.push('RET=' + encodeXText(dsn.ret));
            if (dsn.envid) args.push('ENVID=' + encodeXText(dsn.envid));
        }

        this._sendCommand('MAIL FROM:<' + from + '>' + (args.length ? ' ' + args.join(' ') : ''));
    }

    // 设置DSN信封属性
    _setDsnEnvelope(params) {
        let ret = (params.ret || params.return || '').toString().toUpperCase() || null;
        if (ret)
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
        if (orcpt && !includes(';')) orcpt = 'rfc822;' + orcpt;

        return { ret, envid, notify, orcpt };
    }

    // 获取DSN参数
    _getDsnRcptToArgs() {
        let args = [];
        // 如果服务器支持DSN并且信封包含DSN属性,则将DSN参数附加到RCPT TO命令
        if (this._envelope.dsn && this._supportedExtensions.includes('DSN')) {
            const { notify, orcpt } = this._envelope.dsn;
            if (notify) args.push('NOTIFY=' + encodeXText(notify));
            if (orcpt) args.push('ORCPT=' + encodeXText(orcpt));
        }
        return args.length ? ' ' + args.join(' ') : '';
    }

    //创建发送流
    _createSendStream(callback) {
        let dataStream = new DataStream();
        let logStream;

        const accepted = this._envelope.accepted;
        const lastIndex = accepted.length - 1;
        if (this.options.lmtp)
            accepted.forEach((recipient, i) => {
                this._responseActions.push(str => { this._actionLMTPStream(recipient, i === lastIndex, str, callback); });
            });
        else this._responseActions.push(str => { this._actionSMTPStream(str, callback); });

        dataStream.pipe(this._socket, { end: false });
        if (this.options.debug) {
            logStream = new PassThrough();
            logStream.on('readable', () => {
                let chunk;
                while ((chunk = logStream.read())) {
                    this.logger.debug(
                        {
                            tnx: 'message'
                        },
                        chunk.toString('binary').replace(regexs.OPTIONAL_CRLF, '')
                    );
                }
            });
            dataStream.pipe(logStream);
        }

        const { inByteCount, outByteCount } = dataStream;
        dataStream.once('end', () => {
            this.logger.info(
                {
                    tnx: 'message',
                    inByteCount,
                    outByteCount
                },
                '<%s bytes encoded mime message (source size %s bytes)>',
                outByteCount,
                inByteCount
            );
        });

        return dataStream;
    }

    /** 动作处理函数 **/
    // 发送EHLO/LHLO命令并设置响应处理器
    _sendHeloCommand() {
        const [action, command] = this.options.lmtp ? [this._actionLHLO, 'LHLO'] : [this._actionEHLO, 'EHLO'];
        this._responseActions.push(action);
        this._sendCommand(`${command} ${this.name}`);
    }

    /**
     * 在连接创建后且服务器发送问候消息后运行。
     * 如果传入消息以220开头，则通过发送EHLO命令启动SMTP会话
     *
     * @param {String} str 来自服务器的消息
     */
    _actionGreeting(str) {
        clearTimeout(this._greetingTimeout);
        if (str.substring(0, 3) !== '220') return this._onError(new Error('无效的问候。响应=' + str), 'EPROTOCOL', str, 'CONN');
        this._sendHeloCommand();
    }

    /**
     * 处理LHLO命令的服务器响应。如果产生错误，
     * 发出'error'，否则将其视为EHLO响应
     *
     * @param {String} str 来自服务器的消息
     */
    _actionLHLO(str) {
        if (str.charAt(0) !== '2') return this._onError(new Error('无效的LHLO。响应=' + str), 'EPROTOCOL', str, 'LHLO');
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
        if (str.substring(0, 3) === '421') return this._onError(new Error('服务器终止连接。响应=' + str), 'ECONNECTION', str, 'EHLO');

        // 通用命令队列函数
        const queueCommand = (action, command) => {
            this._responseActions.push(action);
            this._sendCommand(command);
        };

        if (str.charAt(0) !== '2') {
            if (this.options.requireTLS)
                return this._onError(new Error('EHLO失败但HELO不支持必需的STARTTLS。响应=' + str), 'ECONNECTION', str, 'EHLO');
            return queueCommand(this._actionHELO, 'HELO ' + this.name);  // 使用通用函数发送 HELO
        }

        this._ehloLines = str.split(regexs.HEADER_LINE_BREAK)
            .map(line => line.replace(regexs.DIGIT_HYPHEN_PREFIX, '').trim())
            .filter(line => line).slice(1);

        // 检测服务器是否支持STARTTLS
        if (!this.secure && !this.options.ignoreTLS && (regexs.STARTTLS.test(str) || this.options.requireTLS))
            return queueCommand(this._actionSTARTTLS, 'STARTTLS'); // 使用通用函数发送 STARTTLS

        // 检测服务器是否支持SMTPUTF8
        if (regexs.SMTPUTF8.test(str)) this._supportedExtensions.push('SMTPUTF8');

        // 检测服务器是否支持DSN
        if (regexs.DSN.test(str)) this._supportedExtensions.push('DSN');

        // 检测服务器是否支持8BITMIME
        if (regexs._8BITMIME.test(str)) this._supportedExtensions.push('8BITMIME');

        // 检测服务器是否支持PIPELINING
        if (regexs.PIPELINING.test(str)) this._supportedExtensions.push('PIPELINING');

        // 检测服务器是否支持AUTH
        if (regexs.AUTH.test(str)) this.allowsAuth = true;

        // 检测服务器是否支持PLAIN认证
        if (new RegExp(regexs.AUTH_MECHANISM.source + 'PLAIN', 'i').test(str)) this._supportedAuth.push('PLAIN');

        // 检测服务器是否支持LOGIN认证
        if (new RegExp(regexs.AUTH_MECHANISM.source + 'LOGIN', 'i').test(str)) this._supportedAuth.push('LOGIN');

        // 检测服务器是否支持CRAM-MD5认证
        if (new RegExp(regexs.AUTH_MECHANISM.source + 'CRAM-MD5', 'i').test(str)) this._supportedAuth.push('CRAM-MD5');

        // 检测服务器是否支持XOAUTH2认证
        if (new RegExp(regexs.AUTH_MECHANISM.source + 'XOAUTH2', 'i').test(str)) this._supportedAuth.push('XOAUTH2');

        // 检测服务器是否支持SIZE扩展（以及最大允许大小）
        if ((match = str.match(regexs.SIZE))) {
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
        if (str.charAt(0) !== '2') return this._onError(new Error('无效的HELO。响应=' + str), 'EPROTOCOL', str, 'HELO');
        this.allowsAuth = true; // 假设认证已启用
        this.emit('connect');
    }

    /**
     * 处理STARTTLS命令的服务器响应。如果有错误
     * 尝试改用HELO，否则启动TLS升级。如果升级成功，重新启动EHLO
     *
     * @param {String} str 来自服务器的消息
     */
    _actionSTARTTLS(str) {
        if (str.charAt(0) !== '2') {
            if (this.options.opportunisticTLS) {
                this.logger.info({ tnx: 'smtp' }, 'STARTTLS升级失败，继续未加密');
                return this.emit('connect');
            }
            return this._onError(new Error('使用STARTTLS升级连接时出错'), 'ETLS', str, 'STARTTLS');
        }

        this._upgradeConnection((err, secured) => {
            if (err) return this._onError(new Error('启动TLS错误 - ' + (err.message || err)), 'ETLS', false, 'STARTTLS');

            this.logger.info({ tnx: 'smtp' }, '连接已使用STARTTLS升级');
            if (secured) this._sendHeloCommand(); // 重新启动会话
            else this.emit('connect');
        });
    }

    /**
     * 处理AUTH LOGIN用户名认证阶段
     * 预期收到服务器334响应（Base64编码的"Username:"提示）
     * 发送Base64编码的用户名，并准备处理密码认证
     *
     * @param {String} str 服务器响应消息
     * @param {Function} callback 认证结果回调
     */
    _actionAUTH_LOGIN_USER(str, callback) {
        if (!regexs.AUTH_RESPONSE.test(str))
            return callback(this._formatError('在等待"334 VXNlcm5hbWU6"时登录序列无效', 'EAUTH', str, 'AUTH LOGIN'));

        this._responseActions.push(str => { this._actionAUTH_LOGIN_PASS(str, callback); });
        this._sendCommand(Buffer.from(this._auth.credentials.user + '', 'utf-8').toString('base64'));
    }

    /**
     * 处理AUTH CRAM-MD5命令:
     * 1. 服务器发送一个随机字符串
     * 2. 客户端用密码作为密钥，对其进行HMAC-MD5加密
     * 3. 将"用户名 加密结果"进行base64编码后返回给服务器
     *
     * @param {String} str 服务器发送的消息，格式：334 <base64编码的随机字符串>
     * @param {Function} callback 认证结果回调函数
     */
    _actionAUTH_CRAM_MD5(str, callback) {
        let challengeMatch = str.match(regexs.CRAM_MD5_CHALLENGE);
        let challengeString = '';
        if (!challengeMatch) return callback(this._formatError('在等待服务器响应时登录序列无效', 'EAUTH', str, 'AUTH CRAM-MD5'));
        else challengeString = challengeMatch[1];

        // 从base64解码
        let base64decoded = Buffer.from(challengeString, 'base64').toString('ascii'),
            hmacMD5 = createHmac('md5', this._auth.credentials.pass);

        hmacMD5.update(base64decoded);
        let prepended = this._auth.credentials.user + ' ' + hmacMD5.digest('hex');

        this._responseActions.push(str => { this._actionAUTH_CRAM_MD5_PASS(str, callback); });
        this._sendCommand(
            Buffer.from(prepended).toString('base64'),
            Buffer.from(this._auth.credentials.user + ' /* secret */').toString('base64')  // 日志中的隐藏哈希
        );
    }

    /**
     * 处理CRAM-MD5认证的响应，如果没有错误，
     * 用户可以视为已登录。开始等待要发送的消息
     *
     * @param {String} str 来自服务器的消息
     */
    _actionAUTH_CRAM_MD5_PASS(str, callback) {
        if (!str.match(regexs.AUTH_SUCCESS))
            return callback(this._formatError('在等待"235"时登录序列无效', 'EAUTH', str, 'AUTH CRAM-MD5'));

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
     * 处理AUTH LOGIN命令的响应
     * 以'334 UGFzc3dvcmQ6'（'Password:'的base64编码）作为响应发送的数据
     *
     * @param {String} str 来自服务器的消息
     */
    _actionAUTH_LOGIN_PASS(str, callback) {
        if (!regexs.AUTH_RESPONSE.test(str))
            return callback(this._formatError('在等待"334 UGFzc3dvcmQ6"时登录序列无效', 'EAUTH', str, 'AUTH LOGIN'));

        this._responseActions.push(str => { this._actionAUTH_PLAIN_RESPONSE(str, callback); });
        this._sendCommand(
            Buffer.from((this._auth.credentials.pass || '').toString(), 'utf-8').toString('base64'),
            Buffer.from('/* secret */', 'utf-8').toString('base64')  // 日志中的隐藏密码
        );
    }

    /**
     * 处理认证的响应，如果没有错误，
     * 用户可以视为已登录。开始等待要发送的消息
     *
     * @param {String} str 来自服务器的消息
     */
    _actionAUTH_PLAIN_RESPONSE(str, isRetry, callback) {
        if (!callback && typeof isRetry === 'function') {
            callback = isRetry;
            isRetry = false;
        }

        const { user } = this._auth;
        const method = this._authMethod;
        if (str.substring(0, 3) === '334') {
            this._responseActions.push(str => {
                if (isRetry || method !== 'XOAUTH2') this._actionAUTH_PLAIN_RESPONSE(str, true, callback);
                else setImmediate(() => this._actionAUTH_XOAUTH2_TOKEN(true, callback));  // 获取新的OAuth2访问令牌
            });
            this._sendCommand('');
            return;
        }

        if (str.charAt(0) !== '2') {
            this.logger.info(
                {
                    tnx: 'smtp',
                    username: user,
                    action: 'authfail',
                    method
                },
                '用户 %s 认证失败',
                JSON.stringify(user)
            );
            return callback(this._formatError('无效的登录', 'EAUTH', str, 'AUTH ' + method));
        }

        this.logger.info(
            {
                tnx: 'smtp',
                username: user,
                action: 'authenticated',
                method
            },
            '用户 %s 已认证',
            JSON.stringify(user)
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
            if (this._usingSmtpUtf8 && str.startsWith('550 ') && regexs.NON_ASCII.test(this._envelope.from))
                message = '不允许国际化的邮箱名称';
            else message = '邮件命令失败';

            return callback(this._formatError(message, 'EENVELOPE', str, 'MAIL FROM'));
        }

        const { rcptQueue } = this._envelope;
        if (!rcptQueue.length) return callback(this._formatError("无法发送邮件 - 未定义收件人", 'EENVELOPE', false, 'API'));

        this._recipientQueue = [];
        const processRecipient = (recipient) => {
            this._recipientQueue.push(recipient);
            this._responseActions.push(str => { this._actionRCPT(str, callback); });
            this._sendCommand('RCPT TO:<' + recipient + '>' + this._getDsnRcptToArgs());
        };

        // 流水线模式：一次性发送所有收件人
        if (this._supportedExtensions.includes('PIPELINING')) while (rcptQueue.length) { processRecipient(rcptQueue.shift()); }
        else processRecipient(rcptQueue.shift()); // 非流水线模式：逐个发送收件
    }

    /**
     * 处理RCPT TO:命令的响应
     *
     * @param {String} str 来自服务器的消息
     */
    _actionRCPT(str, callback) {
        let message, err,
            curRecipient = this._recipientQueue.shift();
        if (Number(str.charAt(0)) !== 2) {
            if (this._usingSmtpUtf8 && str.startsWith('553 ') && regexs.NON_ASCII.test(curRecipient))
                message = '不允许国际化的邮箱名称';
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
                this._responseActions.push(str => { this._actionDATA(str, callback); });
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
            this._responseActions.push(str => { this._actionRCPT(str, callback); });
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
        if (!regexs.DATA_RESPONSE.test(str)) return callback(this._formatError('数据命令失败', 'EENVELOPE', str, 'DATA'));

        let response = {
            accepted: this._envelope.accepted,
            rejected: this._envelope.rejected
        };

        if (this._ehloLines && this._ehloLines.length) response.ehlo = this._ehloLines;
        if (this._envelope.rejectedErrors.length) response.rejectedErrors = this._envelope.rejectedErrors;

        callback(null, response);
    }

    /**
     * 使用SMTP时处理DATA流的响应,判断发送是否成功
     *
     * @param {String} str 来自服务器的消息
     */
    _actionSMTPStream(str, callback) {
        if (Number(str.charAt(0)) !== 2) return callback(this._formatError('消息失败', 'EMESSAGE', str, 'DATA'));  // 消息失败
        return callback(null, str);  // 消息成功发送
    }

    /**
     * 处理DATA流的响应
     *
     * @param {String} recipient 此响应适用的收件人
     * @param {Boolean} final 是否为最后一个收件人
     * @param {String} str 来自服务器的消息
     */
    _actionLMTPStream(recipient, final, str, callback) {
        // 检查响应状态码
        if (Number(str.charAt(0)) !== 2) {
            const err = this._formatError('收件人 ' + recipient + ' 的消息失败', 'EMESSAGE', str, 'DATA');
            err.recipient = recipient;

            this._envelope.rejected.push(recipient);
            this._envelope.rejectedErrors.push(err);

            const { accepted } = this._envelope;
            const index = accepted.indexOf(recipient);
            if (index > -1) accepted.splice(index, 1);
            return callback(err);
        }

        return callback(null, final ? str : null); // 成功情况：总是调用回调
    }

    // 处理_XOAUTH2认证
    _actionAUTH_XOAUTH2_TOKEN(isRetry, callback) {
        const { oauth2, user } = this._auth;
        oauth2.getToken(isRetry, (err, accessToken) => {
            if (err) {
                this.logger.info(
                    {
                        tnx: 'smtp',
                        username: user,
                        action: 'authfail',
                        method: this._authMethod
                    },
                    '用户 %s 认证失败',
                    JSON.stringify(user)
                );
                return callback(this._formatError(err, 'EAUTH', false, 'AUTH XOAUTH2'));
            }
            this._responseActions.push(str => {
                this._actionAUTH_PLAIN_RESPONSE(str, isRetry, callback);
            });
            this._sendCommand(
                'AUTH XOAUTH2 ' + oauth2.buildXOAuth2Token(accessToken),
                'AUTH XOAUTH2 ' + oauth2.buildXOAuth2Token('/* secret */') // 日志中的隐藏信息
            );
        });
    }

    /**
     * 检查SMTP连接状态并生成对应的错误消息
     * @param {string} command SMTP命令
     * @private
     */
    _isDestroyedMessage(command) {
        if (this._destroyed) return '无法 ' + command + ' - SMTP连接已销毁。';

        if (this._socket) {
            if (this._socket.destroyed) return '无法 ' + command + ' - SMTP连接套接字已销毁。';
            if (!this._socket.writable) return '无法 ' + command + ' - SMTP连接套接字已半关闭。';
        }
    }

    // 获取主机名(设备名或[IP])
    _getHostname() {
        let defaultHostname;
        try {
            defaultHostname = OS.hostname() || '';
        } catch (err) {
            defaultHostname = 'localhost'; // 在Windows 7上失败
        }

        // 如果不是FQDN则忽略
        if (!defaultHostname || !defaultHostname.includes('.')) defaultHostname = '[127.0.0.1]';
        // IP地址应包含在[]中
        if (regexs.IPV4_ADDRESS.test(defaultHostname) || regexs.IPV6_ADDRESS.test(defaultHostname))
            defaultHostname = '[' + defaultHostname + ']';

        return defaultHostname;
    }
}

module.exports = SmtpConnection;