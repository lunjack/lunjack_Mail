'use strict';

// 引入必要的Node.js内置模块
const util = require('util');
const fs = require('fs');
const dns = require('dns');
const NET = require('net');
const OS = require('os');
const PK = (({ name, version, homepage }) => ({ name, version, homepage }))(require('../package.json'));
const wellKnown = require('./well-known');
const nmfetch = require('./fetch');
const { regexs, resetRegex } = require('./regexs');

const DNS_TTL = 5 * 60 * 1000, DNS_MAP = new Map(); // DNS缓存生存时间(5分钟)和DNS缓存Map

/**
 * 检查指定的IP地址族是否被系统支持
 * @param {number} family - IP地址族（4=IPv4, 6=IPv6）
 * @param {boolean} allowInternal - 是否允许内部网络接口
 * @returns {boolean} 是否支持该地址族
 */
function _isFamilySupported(family, allowInternal) {
    try {
        const networkInterfaces = OS.networkInterfaces(); // 获取网络接口信息
        // 如果没有网络接口信息,支持所有地址族;否则,筛选出指定地址族的网络接口
        return !networkInterfaces ? true : Object.values(networkInterfaces).flat()
            .some(i => (!i.internal || allowInternal) && (i.family === `IPv${family}` || i.family === family));
    } catch (err) {
        console.error('获取网络接口信息失败：', err);
        return true;
    }

}

/**
 * DNS解析器
 * @param {number} family - IP地址族
 * @param {string} hostname - 要解析的主机名
 * @param {object} options - 配置选项
 * @param {function} callback - 回调函数
 */
function _resolver(family, hostname, options = {}, callback) {
    // 检查地址族是否支持
    if (!_isFamilySupported(family, options.allowInternalNetworkInterfaces)) return callback(null, []);
    const resolver = dns.Resolver ? new dns.Resolver(options) : dns,              // 创建DNS解析器实例或使用默认的dns模块

        // 可忽略的DNS错误代码列表
        dnsErrs = new Set([dns.NODATA, dns.NOTFOUND, dns.NOTIMP, dns.SERVFAIL, dns.CONNREFUSED, dns.REFUSED, 'EAI_AGAIN']);
    resolver[`resolve${family}`](hostname, (err, addresses) => {
        if (err) return callback(dnsErrs.has(err?.code) ? null : err, []);        // 处理特定的DNS错误代码，返回空数组而不是错误
        const result = Array.isArray(addresses) ? addresses : [addresses].flat(); // 确保返回的是数组
        return callback(null, result);
    });
};

/**
 * 格式化DNS解析结果
 * @param {object} value - DNS解析值
 * @param {object} extra - 额外属性
 * @returns {object} 格式化后的DNS信息
 */
function _formatDNSValue(value, extra = {}) {
    if (!value) return { ...extra };

    const { servername, addresses = [] } = value;
    return {
        servername, host: addresses.length === 0 ? null : addresses.length === 1 ? addresses[0]
            : addresses[Math.floor(Math.random() * addresses.length)], ...extra
    };
}

/**
 * 处理可读流的 readable 事件
 * @param {stream.Readable} stream 可读流实例
 * @param {Buffer[]} chunkArr 存储数据块的数组
 * @param {{value: number}} lenRef 包含value属性的对象，用于累加数据长度
 */
function _handleReadableStream(stream, chunkArr, lenRef) {
    let chunk;
    while ((chunk = stream.read()) !== null) {
        chunkArr.push(chunk), lenRef.value += chunk.length;
    }
}

/**
 * 将流数据读取到Buffer中
 * @param {object} stream - 可读流
 * @param {function} callback - 回调函数
 */
function resolveStream(stream, callback) {
    const chunks = [], chunklen = { value: 0 }, state = { returned: false };

    stream.on('readable', () => _handleReadableStream(stream, chunks, chunklen))
        .on('error', err => {
            cleanup(state), stream.emit('error', err);
            return callback(err);
        })
        .on('end', () => {
            cleanup(state);
            let value;
            try {
                value = Buffer.concat(chunks, chunklen.value);
            } catch (E) {
                return callback(E);
            }
            return callback(null, value);
        });
}

/**
 * 生成一个类似bunyan的日志记录器，输出到控制台
 * @param {array} levels - 日志级别数组
 * @returns {object} Bunyan日志记录器实例
 */
function _createDefaultLogger(levels) {
    // 计算最长日志级别名称的长度并创建固定长度的级别名称
    const levelMaxLen = Math.max(...levels.map(l => l.length)),
        levelNames = new Map(levels.map(l => [l, l.toUpperCase().padEnd(levelMaxLen, ' ')])),
        buildPrefix = entry => {
            if (!entry) return '';
            let prefix = '';

            // 根据事务类型添加前缀
            if (entry.tnx === 'server') prefix = 'S: ';
            else if (entry.tnx === 'client') prefix = 'C: ';

            if (entry.sid) prefix = `[${entry.sid}] ${prefix}`;  // 添加会话ID前缀
            if (entry.cid) prefix = `[#${entry.cid}] ${prefix}`; // 添加连接ID前缀
            return prefix;
        },
        // 打印日志的函数
        print = (level, entry, message, ...args) => {
            const prefix = buildPrefix(entry), formattedMessage = util.format(message, ...args),// 构建前缀,格式化消息
                timestamp = new Date().toISOString().substring(0, 19).replace('T', ' ');        // 格式化时间戳

            // 分行打印（处理多行消息）
            formattedMessage.split(regexs.LINE_SEPARATOR).forEach(line => {
                console.log('[%s] %s %s', timestamp, levelNames.get(level), prefix + line);
            });
        };
    return Object.fromEntries(levels.map(l => [l, print.bind(null, l)])); // 为每个日志级别创建对应的打印函数
}

/**
 * 日志记录函数
 * @param {object} logger - 日志记录器
 * @param {string} level - 日志级别
 * @param {object} defaults - 默认属性
 * @param {object} data - 日志数据
 * @param {string} message - 日志消息
 * @param {...any} args - 其他参数
 */
function _logFunc(logger, level, defaults = {}, data = {}, message, ...args) {
    const { level: l, ...defaultProps } = defaults, { level: l_, ...dataProps } = data; // 排除level属性
    logger[level]({ ...defaultProps, ...dataProps }, message, ...args);                 // 记录合并属性后的日志
}

/**
 * 返回bunyan兼容的日志记录器接口
 * @param {object} options - 配置选项，可能包含'logger'
 * @return {object} bunyan兼容的日志记录器
 */
function getLogger(options = {}, defaults) {
    const levels = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'], { logger } = options;
    if (!logger) return Object.fromEntries(levels.map(level => [level, () => false])); // 如果没有提供日志记录器，创建空实现

    const logger_ = logger === true ? _createDefaultLogger(levels) : logger;          // 如果logger为true,创建控制台日志记录器
    // 包装日志方法
    return Object.fromEntries(
        levels.map(level => [level, (data, message, ...args) => _logFunc(logger_, level, defaults, data, message, ...args)])
    );
}

/**
 * 解析主机名，支持IPv4/IPv6和DNS缓存
 * @param {object} options - 配置选项
 * @param {function} callback - 回调函数
 */
function resolveHostname(options = {}, callback) {
    const { host, servername: sName, dnsTtl } = options,
        // 如果没有host但有servername，使用servername作为host;如果都没有,设置servername为false
        newHost = !host && sName ? sName : host, servername = sName || newHost || false;

    // 如果host是IP地址或为空，直接返回
    if (!newHost || NET.isIP(newHost)) {
        const value = { addresses: [newHost], servername };
        return callback(null, _formatDNSValue(value, { cached: false }));
    }

    // 检查DNS缓存
    let cached;
    if (DNS_MAP.has(newHost)) {
        cached = DNS_MAP.get(newHost);
        // 如果缓存未过期，使用缓存值
        if (!cached.expires || cached.expires >= Date.now()) return callback(null, _formatDNSValue(cached.value, { cached: true }));
    }

    // 处理解析错误
    function handleError(err) {
        return cached ? callback(null, _formatDNSValue(cached.value, { cached: true, error: err })) : callback(err);
    }

    // 处理解析成功(addresses:解析地址数组)
    function handleSuccess(addresses) {
        const value = { addresses, servername };
        DNS_MAP.set(newHost, { value, expires: Date.now() + (dnsTtl || DNS_TTL) });  // 更新DNS缓存
        return callback(null, _formatDNSValue(value, { cached: false }));
    }

    // 首先尝试IPv4解析
    _resolver(4, newHost, options, (err, addrV4) => {
        if (err) return handleError(err);                           // 如果出错但有缓存，使用过期的缓存值,否则返回错误
        if (addrV4?.length) return handleSuccess(addrV4);           // 如果IPv4解析成功,更新DNS缓存,返回成功

        // IPv4失败，尝试IPv6解析
        _resolver(6, newHost, options, (err, addrV6) => {
            if (err) return handleError(err);
            if (addrV6?.length) return handleSuccess(addrV6);      // 如果IPv6解析成功,同理...

            // 如果DNS解析都失败，尝试使用dns.lookup
            try {
                dns.lookup(newHost, { all: true }, (err, lookupAddr) => {
                    if (err) return handleError(err);
                    // 过滤出系统支持的地址族的地址(取第一个支持的地址)
                    const address = lookupAddr?.find(addr => _isFamilySupported(addr.family))?.address || false;

                    // 如果有地址但没有可用的，输出警告
                    if (lookupAddr?.length && !address) console.warn(`无法使用当前网络解析IPv${lookupAddr[0].family}地址`);

                    // 如果没有找到地址但有缓存，使用缓存;否则,使用找到的地址或原始主机名
                    return !address && cached ? callback(null, _formatDNSValue(cached.value, { cached: true })) :
                        handleSuccess(address ? [address] : [newHost]);
                });
            } catch (err) {
                return handleError(err);
            }
        });
    });
}

/**
 * 尝试将给定的字符串解析为URL对象
 * @param {string} str - 需要解析的URL字符串，默认为空字符串
 * @returns {URL|boolean} 如果解析成功返回URL对象，否则返回false
 */
function newURL(str = '') {
    try {
        return str = new URL(str);
    } catch (e) {
        return false;
    }
}

/**
 * 解析连接URL为结构化配置对象
 * @param {string} str - 连接URL字符串
 * @return {object} 配置对象
 */
function parseConnectionUrl(str) {
    const url = newURL(str);
    if (!url) throw new Error(`无效的连接URL:${str}`);
    const protocols = { 'smtp:': { secure: false }, 'smtps:': { secure: true }, 'direct:': { direct: true } }, // 协议映射
        // 值转换
        parseValue = val => {
            if (!isNaN(val)) return Number(val);
            if (val === 'true') return true;
            if (val === 'false') return false;
            return val;
        },
        options = {
            ...protocols[url.protocol], ...(url.port && { port: Number(url.port) }), ...(url.hostname && { host: url.hostname }),
            ...((url.username || url.password) && {
                auth: { user: decodeURIComponent(url.username), pass: url.password ? decodeURIComponent(url.password) : '' }
            })
        };

    // 处理查询参数
    for (const [key, value] of url.searchParams) {
        const parsed = parseValue(value);

        if (key.startsWith('tls.')) {
            const tlsKey = key.slice(4);
            options.tls = { ...options.tls, [tlsKey]: parsed };
        }
        else if (!key.includes('.')) options[key] = parsed;  // 处理其他参数(跳过.*)
    }

    return options;
}

/**
 * 解析Data URI字符串
 * @param {string} uri - Data URI字符串
 * @returns {object|null} 解析后的数据对象或null
 */
function parseDataURI(uri) {
    if (typeof uri !== 'string' || !uri.startsWith('data:')) return null; // 检查参数是否为字符串且以data:开头

    const commaIndex = uri.indexOf(',');          // 安全地查找第一个逗号的索引 -防止ReDoS攻击
    if (commaIndex === -1) return null;           // 如果没有找到逗号，返回

    const data = uri.slice(commaIndex + 1), metaStr = uri.slice(5, commaIndex), metaEntries = metaStr.split(';'),
        // 提取编码类型（最后一个非键值对参数）
        lastEntry = metaEntries.at(-1)?.toLowerCase().trim(), contentType = metaEntries.shift() || 'application/octet-stream',
        encoding = ['base64', 'utf8', 'utf-8'].includes(lastEntry) && !lastEntry.includes('=') ? metaEntries.pop() : null,
        // 解析参数为键值对
        params = Object.fromEntries(
            metaEntries.map(entry => {
                const [key, ...values] = entry.split('=');
                return key?.trim() && values.length ? [key.trim(), values.join('=').trim()] : null;
            }).filter(Boolean)
        );

    // 解码数据，带有错误处理
    let bufferData;
    try {
        bufferData = encoding === 'base64' ? Buffer.from(data, 'base64') : Buffer.from(decodeURIComponent(data));
    } catch {
        try {
            bufferData = Buffer.from(data); // 使用原始数据创建Buffer
        } catch {
            bufferData = Buffer.alloc(0);   // 创建一个空Buffer
        }
    }

    return { data: bufferData, encoding, contentType, params };
}

/**
 * 创建Promise回调包装器
 * @param {function} resolve - Promise resolve函数
 * @param {function} reject - Promise reject函数
 * @returns {function} 回调函数
 */
function callbackPromise(resolve, reject) {
    return (err, ...args) => err ? reject(err) : resolve(...args);// 错误时reject,否则成功resolve
}

/**
 * 解析字符串或Buffer值的内容值
 * @param {object} data - 包含内容的对象或数组
 * @param {string|number} key - 属性名或数组索引
 * @param {function} callback - 回调函数
 * @returns {Promise|null} 可能返回Promise
 */
function resolveContent(data, key, callback) {
    // 如果没有提供回调，创建Promise
    const promise = !callback ? new Promise((resolve, reject) => callback = callbackPromise(resolve, reject)) : null;

    let content = data?.[key]?.content ?? data?.[key];
    if (!content) {
        setImmediate(() => callback(null, content));
        return promise;
    }
    const rEF = resetRegex(regexs.ENCODING_FORMAT),
        encoding = ((data[key]?.encoding || 'utf8')).toString().toLowerCase().replace(rEF, '');

    // 处理不同类型的content
    if (typeof content === 'object') {
        const { path, href, pipe } = content, source = path || href;
        // 如果content是流，则解析
        if (typeof pipe === 'function')
            return resolveStream(content, (err, value) => {
                if (err) return callback(err);
                data[key]?.content ? data[key].content = value : data[key] = value;  // 不能两次流式传输相同内容,所以需要替换流对象
                callback(null, value);
            });
        // 否则，如果content是URL，则解析URL
        else if (regexs.HTTP_URL.test(source)) return resolveStream(nmfetch(source), callback);
        // 否则,如果content是Data URI，则解析Data URI
        else if (regexs.DATA_URL.test(source)) return callback(null, parseDataURI(source)?.data || Buffer.alloc(0));
        // 处理文件路径
        else if (path) return resolveStream(fs.createReadStream(path), callback);
    }

    // 处理特定编码的字符串
    const keyC = data[key]?.content;
    if (typeof keyC === 'string' && !['utf8', 'usascii', 'ascii'].includes(encoding)) content = Buffer.from(keyC, encoding);
    setImmediate(() => callback(null, content)); // 默认操作，原样返回内容
    return promise;
}

/**
 * 将属性从源对象复制到目标对象（支持嵌套的tls和auth属性）
 * @returns {object} 目标对象
 */
function assign(target, ...sources) {
    target = target && typeof target === 'object' ? target : {};  // 确保 target 是对象，如果是假值则重置为空对象

    for (const source of sources) {
        if (!source) continue;
        for (const [k, v] of Object.entries(source))
            // 如果key是tls或auth，并且value是对象，则递归合并对象
            target[k] = ['tls', 'auth'].includes(k) && v && typeof v === 'object' ? { ...target[k], ...v } : v;
    }
    return target;
}

/**
 * 对字符串进行XText编码（SMTP扩展）
 * @param {string} str - 要编码的字符串
 * @returns {string} 编码后的字符串
 */
function encodeXText(str) {
    if (!regexs.NEED_ENCODING.test(str)) return str;
    // 将字符串转换为字节数组，对需要编码的字符转换为"+十六进制"格式，否则保留原字符，最后拼接成字符串
    return Array.from(Buffer.from(str)).map(c => c < 0x21 || c > 0x7E || c === 0x2B || c === 0x3D
        ? `+${c.toString(16).toUpperCase().padStart(2, '0')}` : String.fromCharCode(c)).join('');
}

/**
 * 初始化SMTP传输对象的公共构造函数逻辑
 */
function initSmtpConstructor(instance, options, SmtpC, defaultComponent) {
    if (typeof options === 'string') options = { url: options };         // 如果选项是字符串，则将其视为URL
    const { getSocket, url, service: s } = options;
    if (typeof getSocket === 'function') instance.getSocket = getSocket; // 如果提供了getSocket函数，则使用它

    let urlData, service = s;
    if (url) urlData = parseConnectionUrl(url), service = service || urlData.service; // 解析URL连接选项

    // 合并选项：是否创建对象、常规选项、URL选项和知名服务选项
    instance.options = assign(false, options, urlData, service && wellKnown(service));
    const connection = new SmtpC(instance.options); // 创建临时连接对象用于获取版本信息
    instance.version = `${PK.version}[client:${connection.version}]`;

    // 创建日志记录器
    instance.logger = getLogger(instance.options, { component: instance.options.component || defaultComponent });
}

/**
 * 用于创建代理套接字的占位函数。此方法立即返回而不提供套接字
 *
 * @param {Object} options 连接选项
 * @param {Function} callback 回调函数，用于处理套接字密钥
 */
function getSocket(options, callback) {
    return setImmediate(() => callback(null, false)); // 立即返回空套接字
}

/**用于清理状态对象
 *  @param {Object} state 状态对象
 */
function cleanup(state) {
    if (state.returned) return;
    state.returned = true;
};

/**
 * 回调错误处理函数
 * @param {Object} state 状态对象，包含returned属性
 * @param {Object} connection 连接对象
 * @param {Function} callback 回调函数
 * @param {Error} err 错误对象
 * @param {Object} transport 传输对象 (SmtpPool, PoolResource 或 SmtpTransport)
 */
function callbackErr_(state = {}, connection, callback, err, transport) {
    transport.emit('error', err), state.returned = true, connection.close();
    return callback(err);
}

/**
 * 创建并配置 SMTP 连接
 * @param {Object} transport 传输对象 (SmtpPool, PoolResource 或 SmtpTransport)
 * @param {Object} socketOptions socket 选项
 * @param {Function} SmtpC... SMTP 连接类
 * @returns {Object} 包含处理后的选项和连接实例的对象
 */
function createSmtpConnection(transport, socketOptions, SmtpC) {
    let newOptions = { ...transport.options };

    // 处理代理socket情况
    if (socketOptions?.connection) {
        const { remoteAddress, remotePort } = socketOptions.connection, { host = '', port = '' } = newOptions;
        transport.logger.info({ tnx: 'proxy', remoteAddress, remotePort, destHost: host, destPort: port, action: 'connected' },
            '使用来自 %s:%s 到 %s:%s 的代理socket', remoteAddress, remotePort, host, port
        );
        newOptions = { ...assign(false, newOptions), ...socketOptions };
    }

    const connection = new SmtpC(newOptions);  // 创建SMTP连接实例
    return { options: newOptions, connection };
}

/**
 * 处理连接错误和结束事件的通用逻辑
 * @param {Object} state 状态对象
 * @param {Object} connection 连接对象
 * @param {Function} callback 回调函数
 * @param {Object} transport 传输对象
 * @returns {Object} 清理函数
 */
function setupConnectionHandlers(state, connection, callback, transport) {
    const errorHandler = (err) => {
        if (state.returned) return;
        callbackErr_(state, connection, callback, err, transport);
    },
        endHandler = () => {
            if (state.returned) return;

            const timer = setTimeout(() => {
                if (state.returned) return;
                const err = new Error(connection?._socket?.upgrading ? 'TLS 升级失败' : '意外的套接字关闭');
                if (connection?._socket?.upgrading) err.code = 'ETLS';
                callbackErr_(state, connection, callback, err, transport);
            }, 1000);

            try { timer.unref(); } catch (E) { }
        };

    connection.once('error', errorHandler).once('end', endHandler);
    return () => connection.removeListener('error', errorHandler).removeListener('end', endHandler); // 返回清理函数
}

/**
 * 执行 SMTP 认证的通用逻辑
 * @param {Object} state 状态对象
 * @param {Object} connection 连接对象
 * @param {Object} auth 认证信息
 * @param {Object} options 连接选项
 * @param {Function} callback 回调函数
 * @param {Object} transport 传输对象
 * @param {Function} onSuccess 认证成功后的回调函数
 */
function performSmtpAuthentication(state, connection, auth, options, callback, transport, onSuccess) {
    if (state.returned) return;

    const { allowsAuth } = connection, { forceAuth } = options;
    // 如果需要且支持认证，则进行登录验证
    if (auth && (allowsAuth || forceAuth)) {
        connection.login(auth, err => {
            auth && auth !== transport.auth && auth.oauth2?.removeAllListeners();
            if (state.returned) return;
            err ? callbackErr_(state, connection, callback, err, transport) : onSuccess();
        });
    }
    // 否则, 如果没有认证信息，则返回提供认证错误
    else if (!auth && allowsAuth && forceAuth) {
        const err = new Error('未提供认证信息');
        err.code = 'NoAuth', callbackErr_(state, connection, callback, err, transport);
    }
    else onSuccess(); // 否则，直接执行成功回调
}

/**
 * 创建认证配置的通用逻辑
 * @param {Object} authData 认证数据
 * @param {Object} logger 日志记录器
 * @param {Object} mailer 邮件器实例（可选）
 * @returns {Object|string} 认证配置对象或空字符串
 */
function createAuthConfig(authData, logger, mailer = null, OAUTH2) {
    if (!authData) return '';

    let hasAuth = false;
    const authConfig = {},
        mergeAuthData = source => {
            if (source?.constructor === Object && Object.keys(source).length > 0) Object.assign(authConfig, source), hasAuth = true;
        };
    mergeAuthData(authData);

    if (!hasAuth) return '';
    const { type: rawType, user = '', pass, options, method = '', authMethod = '' } = authConfig,
        type = String(rawType || 'LOGIN').toUpperCase();
    if (type === 'OAUTH2') {
        if (!user) return '';
        const oauth2 = new OAUTH2(authConfig, logger);

        if (mailer) {
            oauth2.provisionCallback = mailer.get('oauth2_provision_cb') || oauth2.provisionCallback;
            oauth2.on('token', token => mailer.emit('token', token));
        }

        oauth2.on('error', err => logger.error({ err, tnx: 'oauth2' }, 'OAuth2 错误: %s', err.message));
        return { type: 'OAUTH2', user, oauth2, method: 'XOAUTH2' };
    }

    if (user || pass)
        return { type, user, credentials: { user, pass, options }, method: method.trim().toUpperCase() || authMethod };

    return '';
}

/**
 * 发送邮件的通用预处理逻辑
 * @param {Object} mail 邮件对象
 * @param {Object} logger 日志记录器
 * @param {String} connectionId 连接ID（可选）
 * @param {Object} options 配置选项（可选）
 * @param {Function} done 发送时执行的回调函数（可选）
 * @returns {Object} 处理后的信封和消息信息
 */
function prepareMessageForSending(mail, logger, connectionId = '', options = {}, done) {
    const { data, message, normalize } = mail,
        { envelope: En, dsn, _dkim, ses } = data, { _headers } = message;
    message.keepBcc = true;     // 保留BCC字段（适用于所有传输类型）

    // 获取信封和消息ID
    const envelope = En || message.getEnvelope(), messageId = message.messageId(), { from, to } = envelope,
        rList = Array.from(to ?? []),
        // 格式化收件人列表:仅显示前3个收件人，超过部分用省略号表示
        recipients = rList.length > 3 ? [...rList.slice(0, 2), `...以及另外${rList.length - 2}个收件人`] : rList;
    if (dsn) envelope.dsn = dsn; // 添加DSN信息（如果存在）

    // 构建日志上下文
    const logContext = { tnx: 'send', messageId, ...(connectionId && { cid: connectionId }) };
    let logMessage, logParams, args, fromAddress = from; // 通用日志记录 - 适配不同传输类型的日志格式
    if (options.transportType === 'json')
        logMessage = '正在为 %s 构建JSON结构，收件人: <%s>', logParams = [messageId, recipients.join(', ')];
    else if (options.transportType === 'sendmail') {
        // 检查无效地址格式（以连字符开头）
        const hasInvalidAddresses = [...(from || []), ...(to || [])].some(addr => addr.startsWith('-'));
        if (hasInvalidAddresses) return done(new Error('无法发送邮件。信封地址无效。'));
        // 构建sendmail参数
        args = this.args ? ['-i', ...this.args, ...to] : ['-i', ...(from ? ['-f', from] : []), ...to];
        logMessage = '正在发送消息%s到<%s>', logParams = [messageId, recipients.join(', ')];
    } else if (options.transportType === 'ses') {
        // From 地址处理
        try {
            const fromHeader = _headers?.find(header => header.key.toLowerCase() === 'from');
            if (fromHeader?.value) fromAddress = fromHeader.value;
        } catch (err) {
            logger.warn({ err, messageId }, '解析 From 头失败，使用默认发件人地址: %s', from);
        }

        logMessage = '正在发送消息 %s 至 <%s>', logParams = [messageId, recipients.join(', ')];
    } else if (options.transportType === 'stream') {
        const lineBreakType = options.winbreak ? '<CR><LF>' : '<LF>';
        logMessage = '正在发送消息 %s 到 <%s>，使用 %s 换行符', logParams = [messageId, recipients.join(', '), lineBreakType];
    } else {
        // SMTP 和其他传输类型的默认日志格式
        logMessage = connectionId ? '正在使用资源 #%s 发送消息 %s 至 <%s>' : '正在发送消息 %s 给 <%s>';
        logParams = connectionId ? [connectionId, messageId, recipients.join(', ')] : [messageId, recipients.join(', ')];
    }

    logger.info(logContext, logMessage, ...logParams);
    return { normalize, envelope, messageId, from: fromAddress, to, _dkim, ses, args, readStream: message.createReadStream() };
}

/**
 * 处理发送结果的通用逻辑
 * @param {Object} result 发送结果
 * @param {Function} callback 回调函数
 * @param {Object} logger 日志记录器
 */
function handleSendResult(result, callback, logger) {
    const { err, info, from, to, messageId } = result;
    if (err) {
        logger.error({ err, tnx: 'send', messageId }, '发送 %s 时出错: %s', messageId, err.message);
        return callback(err);
    }

    // 构建完整的响应信息
    const responseInfo = { ...info, envelope: { from, to }, messageId };
    try {
        callback(null, responseInfo);
    } catch (E) {
        logger.error({ err: E, tnx: 'callback', messageId }, '处理 %s 的回调时出错: %s', messageId, E.message);
    }
}

/**
 * 验证SMTP配置的通用函数
 *
 * @param {Object} transport 传输对象 (SmtpPool 或 SmtpTransport)
 * @param {Function} callback 回调函数
 * @param {Function} SmtpC... SMTP连接类
 * @param {Object} auth 认证信息
 */
function verifySmtp(transport, callback, SmtpC, auth = null) {
    // 如果没有提供回调，则创建Promise
    const promise = !callback ? new Promise((resolve, reject) => callback = callbackPromise(resolve, reject)) : null;

    getSocket(transport.options, (err, socketOp) => {
        if (err) return callback(err);
        const { options: newOp, connection } = createSmtpConnection(transport, socketOp, SmtpC), // 创建并配置SMTP连接
            state = { returned: false }; // 标记是否返回对象

        function finalize(state, connection, callback) {
            cleanup(state), connection.quit(); // 对于验证操作，发送 QUIT 命令优雅关闭
            return callback(null, true);
        }

        // 处理连接错误和连接结束
        connection.once('error', err => {
            if (state.returned) return;
            callbackErr_(state, connection, callback, err, transport);
        }).once('end', () => {
            if (state.returned) return;
            callbackErr_(state, connection, callback, new Error('连接已关闭'), transport);
        });

        // 连接建立后的处理(执行 SMTP 认证并发生才验证结果)
        connection.connect(() => {
            if (state.returned) return;
            performSmtpAuthentication(state, connection, auth, newOp, callback, transport,
                () => finalize(state, connection, callback));
        });
    });

    return promise;
}

// 统一导出
module.exports = {
    PK, util, NET, dns, fs, OS, nmfetch, regexs, resetRegex, newURL,
    resolveHostname, parseConnectionUrl, getLogger, callbackPromise, parseDataURI, resolveContent, resolveStream, assign,
    encodeXText, initSmtpConstructor, getSocket, cleanup, createSmtpConnection, setupConnectionHandlers,
    performSmtpAuthentication, createAuthConfig, prepareMessageForSending, handleSendResult, verifySmtp
};