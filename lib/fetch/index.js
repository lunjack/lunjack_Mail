'use strict';

// 引入必要的Node.js内置模块
const http = require('http'); // HTTP协议模块
const https = require('https'); // HTTPS协议模块
const net = require('net'); // 网络操作模块
const zlib = require('zlib'); // 压缩解压模块
const packageData = require('../../package.json'); // 包信息文件
const Cookies = require('./cookies'); // 自定义Cookie处理模块
const { PassThrough } = require('stream'); // 流处理模块

// 最大重定向次数常量
const MAX_REDIRECTS = 5;

// 核心fetch函数实现
function nmfetch(url, options) {
    // 初始化options参数
    options = options || {};

    // 设置默认响应流、Cookie管理器和重定向计数器
    options.fetchRes = options.fetchRes || new PassThrough();
    options.cookies = options.cookies || new Cookies();
    options.redirects = options.redirects || 0;
    options.maxRedirects = isNaN(options.maxRedirects) ? MAX_REDIRECTS : options.maxRedirects;

    // 处理传入的Cookie选项
    if (options.cookie) {
        [].concat(options.cookie || []).forEach(cookie => {
            options.cookies.set(cookie, url);
        });
        options.cookie = false;
    }

    // 获取响应流
    let fetchRes = options.fetchRes;
    let parsed;
    try {
        parsed = new URL(url);
    } catch (E) {
        finished = true;
        E.type = 'FETCH';
        E.sourceUrl = url;
        fetchRes.emit('error', E);
        return fetchRes;
    }

    // 确定HTTP方法，默认为GET
    let method = (options.method || '').toString().trim().toUpperCase() || 'GET';
    let finished = false; // 请求完成标志
    let cookies;
    let body; // 请求体

    // 根据协议选择HTTP或HTTPS处理器
    let handler = parsed.protocol === 'https:' ? https : http;

    // 设置默认请求头
    let headers = {
        'accept-encoding': 'gzip,deflate', // 接受压缩编码
        'user-agent': 'nodemailer/' + packageData.version // 用户代理标识
    };

    // 合并用户自定义头部
    Object.keys(options.headers || {}).forEach(key => {
        headers[key.toLowerCase().trim()] = options.headers[key];
    });

    // 设置自定义User-Agent（如果提供）
    if (options.userAgent) headers['user-agent'] = options.userAgent;

    // 如果URL中包含认证信息，则设置Authorization头
    if (parsed.username || parsed.password) {
        const auth = `${parsed.username}:${parsed.password}`;
        headers.Authorization = 'Basic ' + Buffer.from(auth).toString('base64');
    }

    // 获取并设置Cookie(如果有)
    if ((cookies = options.cookies.get(url))) headers.cookie = cookies;

    // 处理请求体
    if (options.body) {
        // 设置内容类型（除非明确禁止）
        if (options.contentType !== false) headers['Content-Type'] = options.contentType || 'application/x-www-form-urlencoded';

        // 如果内容类型是流式数据
        if (typeof options.body.pipe === 'function') {
            // 流式数据
            headers['Transfer-Encoding'] = 'chunked';
            body = options.body;
            // 监听流错误
            body.on('error', err => {
                if (finished) return; // 如果已完成则返回
                finished = true;
                err.type = 'FETCH';
                err.sourceUrl = url;
                fetchRes.emit('error', err);
            });
        }
        // 否则, 处理Buffer、对象或字符串类型的请求体
        else {
            if (options.body instanceof Buffer) body = options.body;
            else if (typeof options.body === 'object')
                try {
                    // 将对象转换为URL编码字符串
                    body = Buffer.from(
                        Object.keys(options.body)
                            .map(key => {
                                let value = options.body[key].toString().trim();
                                return encodeURIComponent(key) + '=' + encodeURIComponent(value);
                            })
                            .join('&')
                    );
                } catch (E) {
                    // 处理编码错误
                    if (finished) return; // 已完成则返回
                    finished = true;
                    E.type = 'FETCH';
                    E.sourceUrl = url;
                    fetchRes.emit('error', E);
                    return;
                }
            // 否则, 将其视为字符串
            else body = Buffer.from(options.body.toString().trim());

            // 设置内容类型和长度
            headers['Content-Type'] = options.contentType || 'application/x-www-form-urlencoded';
            headers['Content-Length'] = body.length;
        }
        // 如果有请求体但未指定方法，默认使用POST
        method = (options.method || '').toString().trim().toUpperCase() || 'POST';
    }

    let req;
    // 配置请求选项
    let reqOptions = {
        method,
        host: parsed.hostname,
        path: parsed.pathname + (parsed.search || ''),
        port: parsed.port ? parsed.port : parsed.protocol === 'https:' ? 443 : 80,
        headers,
        rejectUnauthorized: false, // 不验证SSL证书
        agent: false // 不使用连接池
    };

    // 合并TLS选项
    if (options.tls) {
        Object.keys(options.tls).forEach(key => {
            reqOptions[key] = options.tls[key];
        });
    }

    // 处理HTTPS协议的SNI（服务器名称指示）
    if (parsed.protocol === 'https:' && parsed.hostname && parsed.hostname !== reqOptions.host && !net.isIP(parsed.hostname)
        && !reqOptions.servername) reqOptions.servername = parsed.hostname;

    // 创建请求对象
    try {
        req = handler.request(reqOptions);
    } catch (E) {
        // 处理请求创建错误
        finished = true;
        setImmediate(() => {
            E.type = 'FETCH';
            E.sourceUrl = url;
            fetchRes.emit('error', E);
        });
        return fetchRes;
    }

    // 设置超时处理
    if (options.timeout) {
        req.setTimeout(options.timeout, () => {
            if (finished) return; // 已完成则返回
            finished = true;
            req.destroy();
            let err = new Error('Request Timeout');
            err.type = 'FETCH';
            err.sourceUrl = url;
            fetchRes.emit('error', err);
        });
    }

    // 处理请求错误
    req.on('error', err => {
        if (finished) return; // 已完成则返回
        finished = true;
        err.type = 'FETCH';
        err.sourceUrl = url;
        fetchRes.emit('error', err);
    });

    // 处理响应
    req.on('response', res => {
        let inflate; // 解压流
        if (finished) return; // 已完成则返回

        // 根据内容编码创建解压流
        switch (res.headers['content-encoding']) {
            case 'gzip':
            case 'deflate':
                inflate = zlib.createUnzip();
                break;
        }

        // 如果响应中的Set-Cookie头为真，则存储Cookie
        if (res.headers['set-cookie']) {
            [].concat(res.headers['set-cookie'] || []).forEach(cookie => {
                options.cookies.set(cookie, url);
            });
        }

        // 处理重定向
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
            options.redirects++;
            // 如果超过最大重定向次数, 则返回错误
            if (options.redirects > options.maxRedirects) {
                finished = true;
                let err = new Error('Maximum redirect count exceeded');
                err.type = 'FETCH';
                err.sourceUrl = url;
                fetchRes.emit('error', err);
                req.destroy();
                return;
            }
            // 准备重定向请求（GET方法，无请求体）
            options.method = 'GET';
            options.body = false;
            let redirectUrl; // 计算重定向后的URL
            try {
                redirectUrl = new URL(res.headers.location, url).toString(); // 重定向URL为绝对URL
                return nmfetch(redirectUrl, options);
            } catch (E) {
                finished = true;
                E.type = 'FETCH';
                E.sourceUrl = url;
                fetchRes.emit('error', E);
                return;
            }
        }

        // 设置响应状态码和头部
        fetchRes.statusCode = res.statusCode;
        fetchRes.headers = res.headers;

        // 检查状态码是否允许（除非明确允许错误响应）
        if (res.statusCode >= 300 && !options.allowErrorResponse) {
            finished = true;
            let err = new Error('Invalid status code ' + res.statusCode);
            err.type = 'FETCH';
            err.sourceUrl = url;
            fetchRes.emit('error', err);
            req.destroy();
            return;
        }

        // 处理响应错误
        res.on('error', err => {
            if (finished) return; // 已完成则返回
            finished = true;
            err.type = 'FETCH';
            err.sourceUrl = url;
            fetchRes.emit('error', err);
            req.destroy();
        });

        // 将响应流pipe到输出流，支持解压
        if (inflate) {
            res.pipe(inflate).pipe(fetchRes);
            inflate.on('error', err => {
                if (finished) return; // 已完成则返回
                finished = true;
                err.type = 'FETCH';
                err.sourceUrl = url;
                fetchRes.emit('error', err);
                req.destroy();
            });
        }
        else res.pipe(fetchRes);
    });

    // 发送请求体（如果有）
    setImmediate(() => {
        if (body) {
            try {
                // 如果body是流式数据,则直接pipe到请求中
                if (typeof body.pipe === 'function') return body.pipe(req);
                else req.write(body); // 否则写入Buffer数据
            } catch (err) {
                finished = true;
                err.type = 'FETCH';
                err.sourceUrl = url;
                fetchRes.emit('error', err);
                return;
            }
        }
        req.end();
    });

    return fetchRes;
};

// 导出主函数 - 对外提供fetch功能
module.exports = function (url, options) {
    return nmfetch(url, options);
};

// 同时导出Cookies类
module.exports.Cookies = Cookies;