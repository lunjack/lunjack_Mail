'use strict';

// 引入所需模块
const EventEmitter = require('events');
const { randomBytes } = require('crypto');
const MailComposer = require('../mail-composer');
const MailMessage = require('./mail-message');
const DKIM = require('../dkim');
const httpProxyClient = require('../http-proxy-client');
const { detectExtension } = require('../mime-funcs');
const { PK, util, NET, dns, regexs, resetRegex, getLogger, callbackPromise, newURL } = require('../shared');

/**
 * 创建Mail API对象
 *
 * @constructor
 * @param {Object} transporter 用于传递邮件的传输器对象实例
 */
class Mail extends EventEmitter {
    constructor(transporter, options = {}, defaults = {}) {
        super();
        this.options = options, this._defaults = defaults; // 初始化选项和默认值

        // 默认插件配置（编译和流处理阶段）
        this._defaultPlugins = { compile: [(...args) => this._convertDataImages(...args)], stream: [] };

        this._userPlugins = { compile: [], stream: [] };     // 用户自定义插件
        this.meta = new Map();                               // 元数据存储
        const { dkim, proxy, component = 'mail' } = this.options;
        this.dkim = dkim ? new DKIM(dkim) : false;           // DKIM配置（域名密钥识别邮件）
        this.transporter = transporter, this.transporter.mailer = this;                 // 设置传输器并建立反向引用
        this.logger = getLogger(this.options, { component }); // 初始化日志记录器
        this.logger.debug({ tnx: 'create' }, '创建传输器: %s', this.getVersionString()); // 记录创建日志

        // 设置传输器的事件处理器
        if (typeof this.transporter.on === 'function') {
            this.transporter
                // 日志,错误,进入空闲状态,所有连接已终止各事件监听
                .on('log', log => this.logger.debug({ tnx: 'transport' }, '%s: %s', log.type, log.message))
                .on('error', err => {
                    this.logger.error({ err, tnx: 'transport' }, '传输器错误: %s', err.message), this.emit('error', err);
                })
                .on('idle', (...args) => this.emit('idle', ...args)).on('clear', (...args) => this.emit('clear', ...args));
        }

        // 为底层传输器对象添加可选方法
        ['close', 'isIdle', 'verify'].forEach(method => {
            this[method] = (...args) => {
                if (typeof this.transporter[method] === 'function') {
                    // 特殊处理verify方法，设置getSocket
                    if (method === 'verify' && typeof this.getSocket === 'function') this._setupTransporterSocket();
                    return this.transporter[method](...args);
                } else {
                    this.logger.warn({ tnx: 'transport', methodName: method }, '传输器不支持的方法 %s', method);
                    return false;
                }
            };
        });

        if (proxy && typeof proxy === 'string') this.setupProxy(proxy); // 如果有代理，则设置代理
    }

    /**
     * 设置传输器的socket获取方法
     * 将当前实例的getSocket方法赋值给传输器，并重置当前实例的getSocket
     */
    _setupTransporterSocket() {
        this.transporter.getSocket = this.getSocket, this.getSocket = false;
    }

    /**
     * 使用插件
     * @param {string} step 插件阶段（'compile'或'stream'）
     * @param {Function} plugin 插件函数
     */
    use(step = '', plugin) {
        const stepKey = step.toString(), sPlugins = this._userPlugins;
        // 如果没有这个步骤，则创建一个数组，否则添加到数组中
        sPlugins[stepKey] = sPlugins[stepKey] ?? [], sPlugins[stepKey].push(plugin);
        return this;
    }

    /**
     * 使用预选的传输器对象发送邮件
     *
     * @param {Object} data 邮件数据描述
     * @param {Function?} callback 发送成功或失败后运行的回调函数
     */
    sendMail(data, callback = null) {
        // 如果没有提供回调，则创建Promise
        const promise = !callback ? new Promise((resolve, reject) => callback = callbackPromise(resolve, reject)) : null,
            mail = new MailMessage(this, data);                                   // 创建邮件消息对象
        if (typeof this.getSocket === 'function') this._setupTransporterSocket(); // 设置传输器的getSocket方法

        // 记录发送日志
        const { name, version } = this.transporter;
        this.logger.debug({ tnx: 'transport', name, version, action: 'send' }, '使用 %s/%s 发送邮件', name, version);

        const _isCallbackErr = (err, action, context, tnx = 'plugin') => {
            if (err) {
                this.logger.error({ err, tnx, action }, context, err.message);
                return callback(err);
            }
        };

        // 处理编译阶段插件
        this._processPlugins('compile', mail, err => {
            _isCallbackErr(err, 'compile', '插件编译错误: %s'), mail.message = new MailComposer(mail.data).compile();
            mail.setMailerHeader(), mail.setPriorityHeaders(), mail.setListHeaders(); // 设置各种邮件头

            // 处理流阶段插件
            this._processPlugins('stream', mail, err => {
                _isCallbackErr(err, 'stream', '插件流错误: %s');
                const mailDKIM = mail.data.dkim;
                // DKIM签名处理
                if (mailDKIM || this.dkim) {
                    mail.message.processFunc(input => {
                        // 使用邮件数据中的DKIM配置或全局DKIM配置
                        const dkim = mailDKIM ? new DKIM(mailDKIM) : this.dkim;
                        this.logger.debug(
                            {
                                tnx: 'DKIM', messageId: mail.message.messageId(),
                                dkimDomains: dkim.keys.map(key => `${key.keySelector}.${key.domainName}`).join(', ')
                            }, '使用 %s 个密钥签署外发邮件', dkim.keys.length
                        );
                        return dkim.sign(input);
                    });
                }

                // 使用传输器发送邮件
                this.transporter.send(mail, (err, ...args) => {
                    _isCallbackErr(err, 'send', '发送错误: %s', 'transport'), callback(null, ...args);
                });
            });
        });

        return promise;
    }

    /**
     * 获取版本字符串
     */
    getVersionString() {
        const { name, version } = this.transporter;
        return util.format('%s (%s; +%s; %s/%s)', PK.name, PK.version, PK.homepage, name, version);
    }

    /**
     * 处理插件
     * @param {string} step 处理阶段
     * @param {Object} mail 邮件对象
     * @param {Function} callback 回调函数
     */
    _processPlugins(step = '', mail, callback) {
        step = step.toString();
        if (!this._userPlugins.hasOwnProperty(step)) return callback(); // 如果没有这个步骤，则直接返回

        const userPlugins = this._userPlugins[step] || [], defaultPlugins = this._defaultPlugins[step] || [],
            count = userPlugins.length;
        // 记录插件使用情况(如果没有插件，则直接返回)
        if (count) this.logger.debug({ tnx: 'transaction', pluginCount: count, step }, '在 %s 阶段使用 %s 个插件', step, count);
        if (count + defaultPlugins.length === 0) return callback();

        // 递归处理插件
        let pos = 0, block = 'default';
        const processPlugins = () => {
            let curPlugins = block === 'default' ? defaultPlugins : userPlugins;
            // 如果当前位置超过了当前插件列表的长度，则切换到下一个插件列表
            if (pos >= curPlugins.length) {
                if (block === 'default' && count) block = 'user', pos = 0, curPlugins = userPlugins;
                else return callback();
            }
            let plugin = curPlugins[pos++];
            plugin(mail, err => {
                if (err) return callback(err); // 如果插件返回错误，则直接返回
                processPlugins();
            });
        };

        processPlugins();
    }

    /**
     * 为Nodemailer对象设置代理处理器
     *
     * @param {String} proxyUrl 代理配置URL
     */
    setupProxy(proxyUrl) {
        const proxy = newURL(proxyUrl);
        if (!proxy) throw new Error(`无效的代理URL: ${proxyUrl}`);

        // 为mailer对象设置socket处理器
        this.getSocket = (options, callback) => {
            const { protocol: protocol_, href, port: pPort, auth, hostname } = proxy,
                protocol = (protocol_.endsWith(':') ? protocol_.slice(0, -1) : protocol_).toLowerCase(),
                proxyHandlerKey = `proxy_handler_${protocol}`;
            // 检查是否有自定义代理处理器
            if (this.meta.has(proxyHandlerKey)) return this.meta.get(proxyHandlerKey)(proxy, options, callback);
            const { port, host } = options;
            // 根据协议类型处理不同代理
            switch (protocol) {
                // 使用HTTP CONNECT方法连接
                case 'http':
                case 'https':
                    httpProxyClient(href, port, host, (err, socket) => {
                        return err ? callback(err) : callback(null, { connection: socket });
                    });
                    return;
                case 'socks':
                case 'socks5':
                case 'socks4':
                case 'socks4a': {
                    const moduleName = 'proxy_socks_module'
                    // 检查是否已加载Socks模块
                    if (!this.meta.has(moduleName)) return callback(new Error('未加载Socks模块'));

                    const connect = ipaddress => {
                        const proxyV2 = !!this.meta.get(moduleName).SocksClient,
                            socksClient = proxyV2 ? this.meta.get(moduleName).SocksClient : this.meta.get(moduleName),
                            rND = resetRegex(regexs.NON_DIGIT), type = Number(protocol_.replace(rND, '')) || 5,
                            connectionOpts = {
                                proxy: { ipaddress, port: Number(pPort), type },
                                [proxyV2 ? 'destination' : 'target']: { host, port }, command: 'connect'
                            };

                        // 处理代理认证
                        if (auth) {
                            const username = decodeURIComponent(auth.split(':').shift()),
                                password = decodeURIComponent(auth.split(':').pop());
                            // 如果使用Socks5代理v2，则使用userId和password字段，否则使用authentication字段
                            if (proxyV2) connectionOpts.proxy.userId = username, connectionOpts.proxy.password = password;
                            else if (type === 4) connectionOpts.userid = username; // 如果使用Socks4代理，则使用userid字段
                            else connectionOpts.authentication = { username, password };
                        }

                        // 创建SOCKS连接
                        socksClient.createConnection(connectionOpts, (err, info) => {
                            return err ? callback(err) : callback(null, { connection: info.socket || info });
                        });
                    };

                    // 如果代理主机是IP地址，则直接连接
                    if (NET.isIP(hostname)) return connect(hostname);

                    return dns.resolve(hostname, (err, address) => {
                        if (err) return callback(err); // 如果出错，则直接返回
                        connect(Array.isArray(address) ? address[0] : address);
                    });
                }
            }
            callback(new Error('未知代理配置'));
        };
    }

    /**
     * 转换数据URL图片为附件
     * @param {Object} mail 邮件对象
     * @param {Function} callback 回调函数
     */
    _convertDataImages(mail, callback) {
        // 如果没有附件数据URL或没有HTML内容，则直接返回
        if ((!this.options.attachDataUrls && !mail.data.attachDataUrls) || !mail.data.html) return callback();

        // 解析HTML内容
        mail.resolveContent(mail.data, 'html', (err, html = '') => {
            if (err) return callback(err);
            let imgCid = 0, ats;
            const { attachments } = mail.data;

            // 确保attachments是数组
            if (!Array.isArray(attachments)) ats = mail.data.attachments = [].concat(attachments || []);
            const rDUI = resetRegex(regexs.DATA_URL_IMAGE);
            // 替换数据URL为CID引用
            html = html.toString()
                .replace(rDUI, (_match, prefix, dataUri, mimeType) => {
                    // 添加附件
                    const cid = `${randomBytes(10).toString('hex')}@localhost`;
                    ats.push({ path: dataUri, cid, filename: `image-${++imgCid}.${detectExtension(mimeType)}` });
                    return `${prefix}cid:${cid}`;
                });
            mail.data.html = html;
            callback();
        });
    }

    /**
     * 设置元数据
     * @param {*} key 键
     * @param {*} value 值
     */
    set(key, value) {
        return this.meta.set(key, value);
    }

    /**
     * 获取元数据
     * @param {*} key 键
     */
    get(key) {
        return this.meta.get(key);
    }
}

module.exports = Mail;