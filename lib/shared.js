/* eslint no-console: 0 */

'use strict';

// 引入必要的Node.js内置模块
const urllib = require('url');
const util = require('util');
const fs = require('fs');
const dns = require('dns');
const net = require('net');
const os = require('os');
const nmfetch = require('./fetch');

// DNS缓存生存时间（5分钟）
const DNS_TTL = 5 * 60 * 1000;

// 获取网络接口信息
let networkInterfaces;
try {
    networkInterfaces = os.networkInterfaces();
} catch (err) {
    console.error('获取网络接口信息失败：', err);
}

// DNS缓存Map
const dnsCache = new Map();

/**
 * 检查指定的IP地址族是否被系统支持
 * @param {number} family - IP地址族（4=IPv4, 6=IPv6）
 * @param {boolean} allowInternal - 是否允许内部网络接口
 * @returns {boolean} 是否支持该地址族
 */
function _isFamilySupported(family, allowInternal) {
    if (!networkInterfaces) return true; // 如果没有网络接口信息,支持所有地址族

    // 检查是否有指定地址族的网络接口
    const familySupported =
        // 获取所有网络接口（兼容Node.js v6，不使用Object.values）
        Object.keys(networkInterfaces)
            .map(key => networkInterfaces[key])
            // 扁平化数组（兼容旧版Node.js，不使用.flat()）
            .reduce((acc, val) => acc.concat(val), [])
            // 过滤内部接口（如果不需要）
            .filter(i => !i.internal || allowInternal)
            // 过滤指定地址族
            .filter(i => i.family === 'IPv' + family || i.family === family).length > 0;

    return familySupported;
}

/**
 * DNS解析器函数
 * @param {number} family - IP地址族
 * @param {string} hostname - 要解析的主机名
 * @param {object} options - 配置选项
 * @param {function} callback - 回调函数
 */
function _resolver(family, hostname, options, callback) {
    options = options || {};
    // 检查地址族是否支持
    const familySupported = _isFamilySupported(family, options.allowInternalNetworkInterfaces);
    if (!familySupported) return callback(null, []);

    // 创建DNS解析器实例或使用默认的dns模块
    const resolver = dns.Resolver ? new dns.Resolver(options) : dns;
    resolver['resolve' + family](hostname, (err, addresses) => {
        if (err) {
            // 处理特定的DNS错误代码，返回空数组而不是错误
            switch (err.code) {
                case dns.NODATA:
                case dns.NOTFOUND:
                case dns.NOTIMP:
                case dns.SERVFAIL:
                case dns.CONNREFUSED:
                case dns.REFUSED:
                case 'EAI_AGAIN':
                    return callback(null, []);
            }
            return callback(err);
        }
        // 确保返回的是数组
        return callback(null, Array.isArray(addresses) ? addresses : [].concat(addresses || []));
    });
}

/**
 * 格式化DNS解析结果
 * @param {object} value - DNS解析值
 * @param {object} extra - 额外属性
 * @returns {object} 格式化后的DNS信息
 */
function _formatDNSValue(value, extra) {
    if (!value) return Object.assign({}, extra || {});

    return Object.assign(
        {
            servername: value.servername, // 服务器名称
            host:
                !value.addresses || !value.addresses.length ? null // 没有地址返回null
                    : value.addresses.length === 1 ? value.addresses[0] // 单个地址直接返回
                        : value.addresses[Math.floor(Math.random() * value.addresses.length)] // 多个地址随机选择一个
        },
        extra || {}
    );
}

/**
 * 将流数据读取到Buffer中
 * @param {object} stream - 可读流
 * @param {function} callback - 回调函数
 */
function _resolveStream(stream, callback) {
    let responded = false;
    let chunks = [];
    let chunklen = 0;

    stream.on('error', err => {
        if (responded) return;
        responded = true;
        callback(err);
    });

    stream.on('readable', () => {
        let chunk;
        while ((chunk = stream.read()) !== null) {
            chunks.push(chunk);
            chunklen += chunk.length;
        }
    });

    stream.on('end', () => {
        if (responded) return;
        responded = true;

        let value;
        try {
            value = Buffer.concat(chunks, chunklen);
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
    let levelMaxLen = 0;
    let levelNames = new Map();

    // 计算最长日志级别名称的长度
    levels.forEach(level => {
        if (level.length > levelMaxLen) levelMaxLen = level.length;
    });

    // 创建固定长度的日志级别名称
    levels.forEach(level => {
        let levelName = level.toUpperCase();
        if (levelName.length < levelMaxLen) levelName += ' '.repeat(levelMaxLen - levelName.length);
        levelNames.set(level, levelName);
    });

    // 打印日志的函数
    let print = (level, entry, message, ...args) => {
        let prefix = '';
        if (entry) {
            // 根据事务类型添加前缀
            if (entry.tnx === 'server') prefix = 'S: ';
            else if (entry.tnx === 'client') prefix = 'C: ';

            // 添加会话ID前缀
            if (entry.sid) prefix = '[' + entry.sid + '] ' + prefix;

            // 添加连接ID前缀
            if (entry.cid) prefix = '[#' + entry.cid + '] ' + prefix;
        }

        // 格式化消息
        message = util.format(message, ...args);
        // 分行打印（处理多行消息）
        message.split(/\r?\n/).forEach(line => {
            console.log('[%s] %s %s',
                new Date().toISOString().substring(0, 19).replace(/T/, ' '), // 格式化时间戳
                levelNames.get(level), // 日志级别
                prefix + line); // 前缀和消息行
        });
    };

    let logger = {};
    // 为每个日志级别创建对应的打印函数
    levels.forEach(level => {
        logger[level] = print.bind(null, level);
    });

    return logger;
}

/**
 * 解析主机名，支持IPv4/IPv6和DNS缓存
 * @param {object} options - 配置选项
 * @param {function} callback - 回调函数
 */
function resolveHostname(options, callback) {
    options = options || {};

    // 如果没有host但有servername，使用servername作为host
    if (!options.host && options.servername) options.host = options.servername;

    // 如果host是IP地址或为空，直接返回
    if (!options.host || net.isIP(options.host)) {
        let value = {
            addresses: [options.host],
            servername: options.servername || false
        };
        return callback(
            null,
            _formatDNSValue(value, {
                cached: false
            })
        );
    }

    // 检查DNS缓存
    let cached;
    if (dnsCache.has(options.host)) {
        cached = dnsCache.get(options.host);

        // 如果缓存未过期，使用缓存值
        if (!cached.expires || cached.expires >= Date.now())
            return callback(
                null,
                _formatDNSValue(cached.value, {
                    cached: true
                })
            );
    }

    // 首先尝试IPv4解析
    _resolver(4, options.host, options, (err, addresses) => {
        if (err) {
            // 如果出错但有缓存，使用过期的缓存值
            if (cached)
                return callback(
                    null,
                    _formatDNSValue(cached.value, {
                        cached: true,
                        error: err
                    })
                );
            return callback(err);
        }

        // 如果IPv4解析成功
        if (addresses && addresses.length) {
            let value = {
                addresses,
                servername: options.servername || options.host
            };

            // 更新DNS缓存
            dnsCache.set(options.host, {
                value,
                expires: Date.now() + (options.dnsTtl || DNS_TTL)
            });

            return callback(
                null,
                _formatDNSValue(value, {
                    cached: false
                })
            );
        }

        // IPv4失败，尝试IPv6解析
        _resolver(6, options.host, options, (err, addresses) => {
            if (err) {
                if (cached)
                    return callback(
                        null,
                        _formatDNSValue(cached.value, {
                            cached: true,
                            error: err
                        })
                    );
                return callback(err);
            }

            // 如果IPv6解析成功
            if (addresses && addresses.length) {
                let value = {
                    addresses,
                    servername: options.servername || options.host
                };

                dnsCache.set(options.host, {
                    value,
                    expires: Date.now() + (options.dnsTtl || DNS_TTL)
                });

                return callback(
                    null,
                    _formatDNSValue(value, {
                        cached: false
                    })
                );
            }

            // 如果DNS解析都失败，尝试使用dns.lookup
            try {
                dns.lookup(options.host, { all: true }, (err, addresses) => {
                    if (err) {
                        if (cached)
                            return callback(
                                null,
                                _formatDNSValue(cached.value, {
                                    cached: true,
                                    error: err
                                })
                            );
                        return callback(err);
                    }

                    // 过滤出系统支持的地址族的地址
                    let address = addresses
                        ? addresses
                            .filter(addr => _isFamilySupported(addr.family))
                            .map(addr => addr.address)
                            .shift() // 取第一个支持的地址
                        : false;

                    // 如果有地址但没有可用的，输出警告
                    if (addresses && addresses.length && !address) console.warn(`无法使用当前网络解析IPv${addresses[0].family}地址`);

                    // 如果没有找到地址但有缓存，使用缓存
                    if (!address && cached)
                        return callback(
                            null,
                            _formatDNSValue(cached.value, {
                                cached: true
                            })
                        );

                    let value = {
                        addresses: address ? [address] : [options.host], // 使用找到的地址或原始主机名
                        servername: options.servername || options.host
                    };

                    dnsCache.set(options.host, {
                        value,
                        expires: Date.now() + (options.dnsTtl || DNS_TTL)
                    });

                    return callback(
                        null,
                        _formatDNSValue(value, {
                            cached: false
                        })
                    );
                });
            } catch (err) {
                if (cached)
                    return callback(
                        null,
                        _formatDNSValue(cached.value, {
                            cached: true,
                            error: err
                        })
                    )
                return callback(err);
            }
        });
    });
}

/**
 * 解析连接URL为结构化配置对象
 * @param {string} str - 连接URL字符串
 * @return {object} 配置对象
 */
function parseConnectionUrl(str) {
    str = str || '';
    let options = {};

    const url = new URL(str);
    let auth;

    // 根据协议设置安全连接选项
    switch (url.protocol) {
        case 'smtp:':
            options.secure = false; // 非安全SMTP
            break;
        case 'smtps:':
            options.secure = true; // 安全SMTP
            break;
        case 'direct:':
            options.direct = true; // 直连模式
            break;
    }

    // 解析端口号
    if (url.port) options.port = Number(url.port);

    // 解析主机名
    if (url.hostname) options.host = url.hostname;

    // 解析认证信息
    if (url.username || url.password) {
        auth = {
            user: decodeURIComponent(url.username),
            pass: url.password ? decodeURIComponent(url.password) : ''
        };

        if (!options.auth) options.auth = {};

        options.auth.user = auth.user; // 用户名
        options.auth.pass = auth.pass; // 密码
    }

    // 解析查询参数
    url.searchParams.forEach((value, key) => {
        let obj = options;
        let lKey = key;

        // 数值转换
        if (!isNaN(value)) value = Number(value);

        // 布尔值转换
        switch (value) {
            case 'true':
                value = true;
                break;
            case 'false':
                value = false;
                break;
        }

        // 处理TLS相关参数（嵌套对象）
        if (key.indexOf('tls.') === 0) {
            lKey = key.substring(4);

            if (!options.tls) options.tls = {};
            obj = options.tls;
        }
        else if (key.indexOf('.') >= 0) return; // 忽略除tls外的其他嵌套属性

        // 只设置不存在的属性
        if (!(lKey in obj)) obj[lKey] = value;
    });

    return options;
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
function _logFunc(logger, level, defaults, data, message, ...args) {
    let entry = {};

    // 合并默认属性
    Object.keys(defaults || {}).forEach(key => {
        if (key !== 'level') entry[key] = defaults[key];
    });

    // 合并日志数据
    Object.keys(data || {}).forEach(key => {
        if (key !== 'level') entry[key] = data[key];
    });

    // 记录日志
    logger[level](entry, message, ...args);
}

/**
 * 返回bunyan兼容的日志记录器接口
 * @param {object} options - 配置选项，可能包含'logger'
 * @return {object} bunyan兼容的日志记录器
 */
function getLogger(options, defaults) {
    options = options || {};

    let response = {};
    let levels = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'];

    // 如果没有提供日志记录器，创建空实现
    if (!options.logger) {
        levels.forEach(level => {
            response[level] = () => false;
        });
        return response;
    }

    let logger = options.logger;

    // 如果logger为true，创建控制台日志记录器
    if (options.logger === true) logger = _createDefaultLogger(levels);

    // 包装日志方法
    levels.forEach(level => {
        response[level] = (data, message, ...args) => {
            _logFunc(logger, level, defaults, data, message, ...args);
        };
    });

    return response;
}

/**
 * 创建Promise回调包装器
 * @param {function} resolve - Promise resolve函数
 * @param {function} reject - Promise reject函数
 * @returns {function} 回调函数
 */
function callbackPromise(resolve, reject) {
    return function () {
        let args = Array.from(arguments);
        let err = args.shift();
        if (err) reject(err); // 有错误时reject
        else resolve(...args); // 成功时resolve
    };
}

/**
 * 解析Data URI字符串
 * @param {string} uri - Data URI字符串
 * @returns {object|null} 解析后的数据对象或null
 */
function parseDataURI(uri) {
    if (typeof uri !== 'string') return null;

    // 早期返回非Data URI以避免不必要的处理
    if (!uri.startsWith('data:')) return null;

    // 安全地查找第一个逗号 - 防止ReDoS攻击
    const commaPos = uri.indexOf(',');
    if (commaPos === -1) return null;

    const data = uri.substring(commaPos + 1);
    const metaStr = uri.substring('data:'.length, commaPos);

    let encoding;
    const metaEntries = metaStr.split(';');

    if (metaEntries.length > 0) {
        const lastEntry = metaEntries[metaEntries.length - 1].toLowerCase().trim();
        // 只识别有效的编码类型以防止操纵
        if (['base64', 'utf8', 'utf-8'].includes(lastEntry) && lastEntry.indexOf('=') === -1) {
            encoding = lastEntry;
            metaEntries.pop();
        }
    }

    const contentType = metaEntries.length > 0 ? metaEntries.shift() : 'application/octet-stream';
    const params = {};

    // 解析参数
    for (let i = 0; i < metaEntries.length; i++) {
        const entry = metaEntries[i];
        const sepPos = entry.indexOf('=');
        if (sepPos > 0) {
            // 确保'='前面有键名
            const key = entry.substring(0, sepPos).trim();
            const value = entry.substring(sepPos + 1).trim();
            if (key) params[key] = value;
        }
    }

    // 基于编码解码数据，带有适当的错误处理
    let bufferData;
    try {
        if (encoding === 'base64') bufferData = Buffer.from(data, 'base64');
        else {
            try {
                bufferData = Buffer.from(decodeURIComponent(data));
            } catch (decodeError) {
                bufferData = Buffer.from(data);
            }
        }
    } catch (bufferError) {
        bufferData = Buffer.alloc(0);
    }

    return {
        data: bufferData,
        encoding: encoding || null,
        contentType: contentType || 'application/octet-stream',
        params
    };
}

/**
 * 解析字符串或Buffer值的内容值
 * @param {object} data - 包含内容的对象或数组
 * @param {string|number} key - 属性名或数组索引
 * @param {function} callback - 回调函数
 * @returns {Promise|undefined} 可能返回Promise
 */
function resolveContent(data, key, callback) {
    let promise;

    // 如果没有提供回调，创建Promise
    if (!callback)
        promise = new Promise((resolve, reject) => {
            callback = callbackPromise(resolve, reject);
        });

    let content = (data && data[key] && data[key].content) || data[key];
    let contentStream;
    let encoding = ((typeof data[key] === 'object' && data[key].encoding) || 'utf8')
        .toString()
        .toLowerCase()
        .replace(/[-_\s]/g, '');

    if (!content) return callback(null, content);

    // 处理不同类型的content
    if (typeof content === 'object') {
        // 如果content是流，则解析流
        if (typeof content.pipe === 'function')
            return _resolveStream(content, (err, value) => {
                if (err) return callback(err);

                // 不能两次流式传输相同内容，所以需要替换流对象
                if (data[key].content) data[key].content = value;
                else data[key] = value;

                callback(null, value);
            });
        // 否则，如果content是URL，则解析URL
        else if (/^https?:\/\//i.test(content.path || content.href)) {
            contentStream = nmfetch(content.path || content.href);
            return _resolveStream(contentStream, callback);
        }
        // 否则,如果content是Data URI，则解析Data URI
        else if (/^data:/i.test(content.path || content.href)) {
            let parsedDataUri = parseDataURI(content.path || content.href);

            if (!parsedDataUri || !parsedDataUri.data) return callback(null, Buffer.from(0));
            return callback(null, parsedDataUri.data);
        }
        // 处理文件路径
        else if (content.path) return _resolveStream(fs.createReadStream(content.path), callback);
    }

    // 处理特定编码的字符串
    if (typeof data[key].content === 'string' && !['utf8', 'usascii', 'ascii'].includes(encoding))
        content = Buffer.from(data[key].content, encoding);

    // 默认操作，原样返回
    setImmediate(() => callback(null, content));

    return promise;
}

/**
 * 将属性从源对象复制到目标对象（支持嵌套的tls和auth属性）
 * @returns {object} 目标对象
 */
function assign(/* target, ... sources */) {
    let args = Array.from(arguments);
    let target = args.shift() || {};

    args.forEach(source => {
        Object.keys(source || {}).forEach(key => {
            // 如果key是tls或auth，则递归复制子属性
            if (['tls', 'auth'].includes(key) && source[key] && typeof source[key] === 'object') {
                if (!target[key]) target[key] = {};

                Object.keys(source[key]).forEach(subKey => {
                    target[key][subKey] = source[key][subKey];
                });
            }
            else target[key] = source[key];
        });
    });
    return target;
}

/**
 * 对字符串进行XText编码（SMTP扩展）
 * @param {string} str - 要编码的字符串
 * @returns {string} 编码后的字符串
 */
function encodeXText(str) {
    // 可打印ASCII字符范围：! (0x21) 到 ~ (0x7E);但需要编码 + (0x2B) 和 = (0x3D)
    if (!/[^\x21-\x2A\x2C-\x3C\x3E-\x7E]/.test(str)) return str; // 如果不需要编码，直接返回

    let buf = Buffer.from(str);
    let result = '';
    for (let i = 0, len = buf.length; i < len; i++) {
        let c = buf[i];
        // 编码控制字符、+和=
        if (c < 0x21 || c > 0x7e || c === 0x2b || c === 0x3d) result += '+' + (c < 0x10 ? '0' : '') + c.toString(16).toUpperCase();
        else result += String.fromCharCode(c);
    }
    return result;
}

// 统一导出
module.exports = {
    networkInterfaces,
    dnsCache,
    resolveHostname,
    parseConnectionUrl,
    getLogger,
    callbackPromise,
    parseDataURI,
    resolveContent,
    assign,
    encodeXText,
    _logFunc
};