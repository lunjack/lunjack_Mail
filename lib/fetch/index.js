'use strict';

// 引入必要的Node.js内置模块
const http = require('http');
const https = require('https');
const net = require('net');
const zlib = require('zlib');              // 压缩解压模块
const { PassThrough } = require('stream'); // 流处理模块
const packageData = require('../../package.json');
const Cookies = require('./cookies');

// 最大重定向次数常量
const MAX_REDIRECTS = 5;

// 错误处理函数(fetchRes: 响应流)
function handleError(fetchRes, error, url) {
    error.type = 'FETCH';
    error.sourceUrl = url;
    fetchRes.emit('error', error);
}

// 标记请求完成并返回错误
function markFinishedWithError(finishedFlag, fetchRes, error, url) {
    if (finishedFlag.value) return;
    finishedFlag.value = true;
    handleError(fetchRes, error, url);
}

// 解析URL函数
function parseUrl(url, fetchRes) {
    try {
        return { success: true, result: new URL(url) };
    } catch (error) {
        handleError(fetchRes, error, url);
        return { success: false, error };
    }
}

// 处理请求体函数
function processRequestBody(options, url, fetchRes, finishedFlag, method) {
    let body = null;

    // 设置内容类型（除非明确禁止）
    if (options.contentType !== false) options.headers['Content-Type'] = options.contentType || 'application/x-www-form-urlencoded';

    // 如果内容类型是流式数据
    if (typeof options.body.pipe === 'function') {
        options.headers['Transfer-Encoding'] = 'chunked';
        body = options.body;
        // 监听流错误
        body.on('error', err => {
            markFinishedWithError(finishedFlag, fetchRes, err, url);
        });
    }
    // 否则, 处理Buffer、对象或字符串类型的请求体
    else {
        if (options.body instanceof Buffer) body = options.body;
        else if (typeof options.body === 'object') {
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
            } catch (error) {
                handleError(fetchRes, error, url);
                return { success: false, error };
            }
        }
        // 否则, 将其视为字符串
        else body = Buffer.from(options.body.toString().trim());

        // 设置内容长度
        options.headers['Content-Length'] = body.length;
    }

    method = method || 'POST'; // 如果有请求体但未指定方法，默认使用POST
    return { success: true, body };
}

// 处理重定向函数
function handleRedirect(res, url, options, fetchRes, finishedFlag) {
    if (![301, 302, 303, 307, 308].includes(res.statusCode) || !res.headers.location) return false;

    options.redirects++;
    // 如果超过最大重定向次数, 则返回错误
    if (options.redirects > options.maxRedirects) {
        const err = new Error('超过最大重定向次数');
        markFinishedWithError(finishedFlag, fetchRes, err, url);
        req.destroy();
        return true;
    }

    // 准备重定向请求（GET方法，无请求体）
    options.method = 'GET';
    options.body = false;

    try {
        const redirectUrl = new URL(res.headers.location, url).toString(); // 重定向URL为绝对URL
        nmfetch(redirectUrl, options);
        return true;
    } catch (error) {
        markFinishedWithError(finishedFlag, fetchRes, error, url);
        return true;
    }
}

// 核心fetch函数实现
function nmfetch(url, options = {}) {
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

    let fetchRes = options.fetchRes;     // 获取响应流
    let finishedFlag = { value: false }; // 使用对象包装finished标志，便于在函数间传递引用

    // 解析URL
    const parsedResult = parseUrl(url, fetchRes);
    if (!parsedResult.success) return fetchRes;
    const parsed = parsedResult.result;

    // 确定HTTP方法，默认为GET
    let method = (options.method || '').toString().trim().toUpperCase() || 'GET';
    let cookies;
    let handler = parsed.protocol === 'https:' ? https : http;

    // 设置默认请求头
    let headers = {
        'accept-encoding': 'gzip,deflate',
        'user-agent': 'nodemailer/' + packageData.version
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
    const bodyResult = processRequestBody(options, url, fetchRes, finishedFlag, method);
    if (!bodyResult.success) return fetchRes;

    let req;
    // 配置请求选项
    let reqOptions = {
        method,
        host: parsed.hostname,
        path: parsed.pathname + (parsed.search || ''),
        port: parsed.port ? parsed.port : parsed.protocol === 'https:' ? 443 : 80,
        headers,
        rejectUnauthorized: false,// 不验证SSL证书
        agent: false              // 不使用连接池
    };

    // 合并TLS选项
    if (options.tls)
        Object.keys(options.tls).forEach(key => {
            reqOptions[key] = options.tls[key];
        });

    // 处理HTTPS协议的SNI
    if (parsed.protocol === 'https:' && parsed.hostname && parsed.hostname !== reqOptions.host && !net.isIP(parsed.hostname)
        && !reqOptions.servername) reqOptions.servername = parsed.hostname;

    // 创建请求对象
    try {
        req = handler.request(reqOptions);
    } catch (error) {
        setImmediate(() => {
            markFinishedWithError(finishedFlag, fetchRes, error, url);
        });
        return fetchRes;
    }

    // 设置超时处理
    if (options.timeout) {
        req.setTimeout(options.timeout, () => {
            const err = new Error('Request Timeout');
            markFinishedWithError(finishedFlag, fetchRes, err, url);
            req.destroy();
        });
    }

    // 处理请求错误
    req.on('error', err => {
        markFinishedWithError(finishedFlag, fetchRes, err, url);
    });

    // 处理响应
    req.on('response', res => {
        let inflate; // 解压流
        if (finishedFlag.value) return;

        // 根据内容编码创建解压流
        switch (res.headers['content-encoding']) {
            case 'gzip':
            case 'deflate':
                inflate = zlib.createUnzip();
                break;
        }

        // 如果响应中的Set-Cookie头为真，则存储Cookie
        if (res.headers['set-cookie'])
            [].concat(res.headers['set-cookie'] || []).forEach(cookie => {
                options.cookies.set(cookie, url);
            });

        // 处理重定向
        if (handleRedirect(res, url, options, fetchRes, finishedFlag)) return;

        // 设置响应状态码和头部
        fetchRes.statusCode = res.statusCode;
        fetchRes.headers = res.headers;

        // 检查状态码是否允许
        if (res.statusCode >= 300 && !options.allowErrorResponse) {
            const err = new Error('响应状态码无效: ' + res.statusCode);
            markFinishedWithError(finishedFlag, fetchRes, err, url);
            req.destroy();
            return;
        }

        // 处理响应错误
        res.on('error', err => {
            markFinishedWithError(finishedFlag, fetchRes, err, url);
            req.destroy();
        });

        // 将响应流pipe到输出流，支持解压
        if (inflate) {
            res.pipe(inflate).pipe(fetchRes);
            inflate.on('error', err => {
                markFinishedWithError(finishedFlag, fetchRes, err, url);
                req.destroy();
            });
        }
        else res.pipe(fetchRes);
    });

    // 发送请求体（如果有）
    setImmediate(() => {
        if (bodyResult.body) {
            try {
                if (typeof bodyResult.body.pipe === 'function') return bodyResult.body.pipe(req);
                else req.write(bodyResult.body);
            } catch (err) {
                markFinishedWithError(finishedFlag, fetchRes, err, url);
                return;
            }
        }
        req.end();
    });

    return fetchRes;
};

// 导出主函数
module.exports = function (url, options) {
    return nmfetch(url, options);
};