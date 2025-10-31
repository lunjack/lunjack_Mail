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
    const resolver = dns.Resolver ? new dns.Resolver(options) : dns;              // 创建DNS解析器实例或使用默认的dns模块

    // 可忽略的DNS错误代码列表
    const dnsErrs = new Set([dns.NODATA, dns.NOTFOUND, dns.NOTIMP, dns.SERVFAIL, dns.CONNREFUSED, dns.REFUSED, 'EAI_AGAIN']);
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
function handleReadableStream(stream, chunkArr, lenRef) {
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
function _resolveStream(stream, callback) {
    let responded = false;
    const chunks = [], chunklen = { value: 0 };
    function cleanup() {
        if (responded) return;
        responded = true;
    };

    stream.on('error', err => { cleanup(), callback(err) });
    stream.on('readable', () => handleReadableStream(stream, chunks, chunklen));
    stream.on('end', () => {
        cleanup();
        let value;
        try {
            value = Buffer.concat(chunks, chunklen.value);
        } catch (E) {
            return callback(E);
        }
        callback(null, value);
    });
}

/**
 * 生成一个类似bunyan的日志记录器，输出到控制台
 * @param {array} levels - 日志级别数组
 * @returns {object} Bunyan日志记录器实例
 */
function _createDefaultLogger(levels) {
    // 计算最长日志级别名称的长度并创建固定长度的级别名称
    const levelMaxLen = Math.max(...levels.map(l => l.length));
    const levelNames = new Map(levels.map(l => [l, l.toUpperCase().padEnd(levelMaxLen, ' ')]));
    // 打印日志的函数
    const print = (level, entry, message, ...args) => {
        const prefix = buildPrefix(entry);                      // 构建前缀
        const formattedMessage = util.format(message, ...args); // 格式化消息
        const timestamp = new Date().toISOString().substring(0, 19).replace('T', ' '); // 格式化时间戳

        // 分行打印（处理多行消息）
        formattedMessage.split(regexs.HEADER_LINE_BREAK).forEach(line => {
            console.log('[%s] %s %s', timestamp, levelNames.get(level), prefix + line);
        });
    };

    const buildPrefix = (entry) => {
        if (!entry) return '';
        let prefix = '';

        // 根据事务类型添加前缀
        if (entry.tnx === 'server') prefix = 'S: ';
        else if (entry.tnx === 'client') prefix = 'C: ';

        if (entry.sid) prefix = `[${entry.sid}] ${prefix}`;  // 添加会话ID前缀
        if (entry.cid) prefix = `[#${entry.cid}] ${prefix}`; // 添加连接ID前缀
        return prefix;
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
    const { level: l, ...defaultProps } = defaults; // 排除level属性
    const { level: l_, ...dataProps } = data;       // 同理
    logger[level]({ ...defaultProps, ...dataProps }, message, ...args); // 记录合并属性后的日志
}

/**
 * 返回bunyan兼容的日志记录器接口
 * @param {object} options - 配置选项，可能包含'logger'
 * @return {object} bunyan兼容的日志记录器
 */
function getLogger(options = {}, defaults) {
    const levels = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'], { logger } = options;

    // 如果没有提供日志记录器，创建空实现
    if (!logger) return Object.fromEntries(levels.map(level => [level, () => false]));

    // 如果logger为true，创建控制台日志记录器
    const logger_ = logger === true ? _createDefaultLogger(levels) : logger;

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
    const { host, servername: sName, dnsTtl } = options;
    // 如果没有host但有servername，使用servername作为host;如果都没有,设置servername为false
    const newHost = !host && sName ? sName : host, servername = sName || newHost || false;

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
    const protocols = { 'smtp:': { secure: false }, 'smtps:': { secure: true }, 'direct:': { direct: true } }; // 协议映射

    // 值转换
    const parseValue = val => {
        if (!isNaN(val)) return Number(val);
        if (val === 'true') return true;
        if (val === 'false') return false;
        return val;
    };

    const options = {
        ...protocols[url.protocol],
        ...(url.port && { port: Number(url.port) }),
        ...(url.hostname && { host: url.hostname }),
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
        else if (!key.includes('.')) { options[key] = parsed; } // 处理其他参数(跳过.*)
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

    const data = uri.slice(commaIndex + 1), metaStr = uri.slice(5, commaIndex), metaEntries = metaStr.split(';');

    // 提取编码类型（最后一个非键值对参数）
    const lastEntry = metaEntries.at(-1)?.toLowerCase().trim();
    const encoding = ['base64', 'utf8', 'utf-8'].includes(lastEntry) && !lastEntry.includes('=') ? metaEntries.pop() : null;
    const contentType = metaEntries.shift() || 'application/octet-stream';

    // 解析参数为键值对
    const params = Object.fromEntries(
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
 * @returns {Promise|undefined} 可能返回Promise
 */
function resolveContent(data, key, callback) {
    // 如果没有提供回调，创建Promise
    const promise = !callback ? new Promise((resolve, reject) => { callback = callbackPromise(resolve, reject); }) : undefined;

    let content = data?.[key]?.content ?? data?.[key];
    if (!content) return callback(null, content);
    resetRegex(regexs.ENCODING_FORMAT);
    const encoding = ((data[key]?.encoding || 'utf8')).toString().toLowerCase().replace(regexs.ENCODING_FORMAT, '');

    // 处理不同类型的content
    if (typeof content === 'object') {
        const { path, href, pipe } = content;
        const source = path || href;
        // 如果content是流，则解析流
        if (typeof pipe === 'function')
            return _resolveStream(content, (err, value) => {
                if (err) return callback(err);
                data[key]?.content ? data[key].content = value : data[key] = value;  // 不能两次流式传输相同内容,所以需要替换流对象
                callback(null, value);
            });
        // 否则，如果content是URL，则解析URL
        else if (regexs.HTTP_URL.test(source)) return _resolveStream(nmfetch(source), callback);
        // 否则,如果content是Data URI，则解析Data URI
        else if (regexs.DATA_URL.test(source)) return callback(null, parseDataURI(source)?.data || Buffer.alloc(0));
        // 处理文件路径
        else if (path) return _resolveStream(fs.createReadStream(path), callback);
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
        for (const [k, v] of Object.entries(source)) {
            // 如果key是tls或auth，并且value是对象，则递归合并对象
            target[k] = ['tls', 'auth'].includes(k) && v && typeof v === 'object' ? { ...target[k], ...v } : v;
        }
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
 * 处理代理socket配置并创建SMTP连接
 *
 * @param {Object} options 原始连接选项
 * @param {Object} logger 日志记录器
 * @param {Object} socketOptions socket选项
 * @param {Function} ConnectionClass SMTP连接类
 * @returns {Object} 包含处理后的选项和连接实例的对象
 */
function createProxyConnection(options, logger, socketOptions, SmtpC) {
    let newOptions = options;

    // 处理代理socket情况
    if (socketOptions?.connection) {
        const { remoteAddress, remotePort } = socketOptions.connection;
        const { host = '', port = '' } = options;
        logger.info({ tnx: 'proxy', remoteAddress, remotePort, destHost: host, destPort: port, action: 'connected' },
            '使用来自 %s:%s 到 %s:%s 的代理socket', remoteAddress, remotePort, host, port
        );

        newOptions = { ...assign(false, options), ...socketOptions };
    }

    const connection = new SmtpC(newOptions);  // 创建SMTP连接实例
    return { options: newOptions, connection };
}

/**
 * 格式化收件人列表用于显示
 * @param {Array|string} recipients 收件人列表
 * @returns {Array} 格式化后的收件人数组
 */
function formatRecipients(recipients) {
    const rList = Array.from(recipients ?? []);
    // 仅显示前3个收件人，超过部分用省略号表示
    return rList.length > 3 ? [...rList.slice(0, 2), `...以及另外${rList.length - 2}个收件人`] : rList;
}

/**
 * 初始化SMTP传输对象的公共构造函数逻辑
 */
function initSmtpConstructor(instance, options, SmtpC, defaultComponent) {
    if (typeof options === 'string') options = { url: options };                         // 如果选项是字符串，则将其视为URL
    const { getSocket, url, service: s } = options;
    if (typeof getSocket === 'function') instance.getSocket = getSocket; // 如果提供了getSocket函数，则使用它

    let urlData, service = s;
    // 解析URL连接选项
    if (url) {
        urlData = parseConnectionUrl(url);
        service = service || urlData.service;
    }

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

// 统一导出
module.exports = {
    resolveHostname,
    parseConnectionUrl,
    getLogger,
    callbackPromise,
    parseDataURI,
    resolveContent,
    handleReadableStream,
    assign,
    encodeXText,
    createProxyConnection,
    formatRecipients,
    initSmtpConstructor,
    getSocket,
    PK, util, NET, dns, fs, OS, nmfetch, regexs, resetRegex, newURL
};