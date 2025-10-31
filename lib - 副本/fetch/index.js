'use strict';

// 引入必要的Node.js内置模块
const http = require('http');
const https = require('https');
const NET = require('net');
const zlib = require('zlib');              // 压缩解压模块
const { PassThrough } = require('stream'); // 流处理模块
const PK = require('../../package.json');
const Cookies = require('./cookies');

// 最大重定向次数常量
const MAX_REDIRECTS = 5;

// 错误处理函数(fetchRes: 响应流)
function _handleError(fetchRes, error, url) {
    error.type = 'FETCH';
    error.sourceUrl = url;
    fetchRes.emit('error', error);
}

// 标记请求完成并返回错误
function _markFinishedWithError(finishedFlag, fetchRes, error, url) {
    if (finishedFlag.value) return;
    finishedFlag.value = true;
    _handleError(fetchRes, error, url);
}

// 解析URL函数
function _parseUrl(url, fetchRes) {
    try {
        return { success: true, result: new URL(url) };
    } catch (error) {
        _handleError(fetchRes, error, url);
        return { success: false, error };
    }
}

// 处理请求体函数
function _processRequestBody(options, url, fetchRes, finishedFlag) {
    let processedBody = null;
    const { contentType, body, headers } = options;

    // 设置内容类型（除非明确禁止）
    if (contentType !== false) headers['Content-Type'] = contentType || 'application/x-www-form-urlencoded';

    // 流式数据处理
    if (typeof body?.pipe === 'function') {
        headers['Transfer-Encoding'] = 'chunked';
        processedBody = body;
        processedBody.on('error', err => _markFinishedWithError(finishedFlag, fetchRes, err, url));
    }
    // 非流式数据处理
    else {
        try {
            if (body instanceof Buffer) processedBody = body;
            else if (typeof body === 'object')
                // 对象转 URL 编码字符串
                processedBody = Buffer.from(
                    Object.entries(body)
                        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v.toString().trim())}`).join('&'));
            else processedBody = Buffer.from(String(body).trim()); // 字符串处理

            // 设置内容长度
            headers['Content-Length'] = processedBody.length;
        } catch (error) {
            _handleError(fetchRes, error, url);
            return { success: false, error };
        }
    }

    return { success: true, body: processedBody };
}

// 处理重定向函数
function _handleRedirect(res, url, options, fetchRes, finishedFlag, req) {
    if (![301, 302, 303, 307, 308].includes(res.statusCode) || !res.headers.location) return false;

    options.redirects++;
    // 如果超过最大重定向次数, 则返回错误
    if (options.redirects > options.maxRedirects) {
        const err = new Error('超过最大重定向次数');
        _markFinishedWithError(finishedFlag, fetchRes, err, url);
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
        _markFinishedWithError(finishedFlag, fetchRes, error, url);
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
        [].concat(options.cookie).forEach(cookie => options.cookies.set(cookie, url));
        options.cookie = false;
    }

    const fetchRes = options.fetchRes;     // 获取响应流
    const finishedFlag = { value: false }; // 使用对象包装finished标志，便于在函数间传递引用

    // 解析URL
    const parsedResult = _parseUrl(url, fetchRes);
    if (!parsedResult.success) return fetchRes;
    const { protocol, hostname, pathname, search, port, username, password } = parsedResult.result;

    // 确定HTTP方法，默认为GET
    let method = (options.method || '').toString().trim().toUpperCase() || 'GET';
    let cookies;
    const handler = protocol === 'https:' ? https : http;

    // 设置默认请求头
    const headers = {
        'accept-encoding': 'gzip,deflate',
        'user-agent': 'lunjack-mail/' + PK.version
    };

    // 合并用户自定义头部
    Object.keys(options.headers || {}).forEach(key => headers[key.toLowerCase().trim()] = options.headers[key]);

    // 设置自定义User-Agent（如果提供）
    if (options.userAgent) headers['user-agent'] = options.userAgent;

    // 如果URL中包含认证信息，则设置Authorization头
    if (username || password) {
        const auth = `${username}:${password}`;
        headers.Authorization = 'Basic ' + Buffer.from(auth).toString('base64');
    }

    // 获取并设置Cookie(如果有)
    if ((cookies = options.cookies.get(url))) headers.cookie = cookies;

    // 处理请求体
    const bodyResult = _processRequestBody(options, url, fetchRes, finishedFlag);
    if (!bodyResult.success) return fetchRes;
    method = method || 'POST'; // 默认 POST 方法

    let req;
    // 配置请求选项
    const reqOptions = {
        method, host: hostname, path: pathname + (search || ''), port: port ? port : protocol === 'https:' ? 443 : 80, headers,
        rejectUnauthorized: false, // 不验证SSL证书
        agent: false               // 不使用连接池
    };

    if (options.tls) Object.assign(reqOptions, options.tls); // 合并TLS选项
    // 处理HTTPS协议的SNI
    if (protocol === 'https:' && hostname && !NET.isIP(hostname) && !reqOptions.servername) reqOptions.servername = hostname;

    // 创建请求对象
    try {
        req = handler.request(reqOptions);
    } catch (error) {
        setImmediate(() => _markFinishedWithError(finishedFlag, fetchRes, error, url));
        return fetchRes;
    }

    // 设置超时处理
    if (options.timeout) {
        req.setTimeout(options.timeout, () => {
            const err = new Error('Request Timeout');
            _markFinishedWithError(finishedFlag, fetchRes, err, url);
            req.destroy();
        });
    }

    // 处理请求错误
    req.on('error', err => _markFinishedWithError(finishedFlag, fetchRes, err, url));

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
        const setCookie = res.headers['set-cookie'];
        if (setCookie) [].concat(setCookie).forEach(cookie => options.cookies.set(cookie, url));

        // 处理重定向
        if (_handleRedirect(res, url, options, fetchRes, finishedFlag, req)) return;

        // 设置响应状态码和头部
        fetchRes.statusCode = res.statusCode;
        fetchRes.headers = res.headers;

        // 检查状态码是否允许
        if (res.statusCode >= 300 && !options.allowErrorResponse) {
            const err = new Error(`响应状态码无效:${res.statusCode}`);
            _markFinishedWithError(finishedFlag, fetchRes, err, url);
            req.destroy();
            return;
        }

        // 处理响应错误
        res.on('error', err => {
            _markFinishedWithError(finishedFlag, fetchRes, err, url);
            req.destroy();
        });

        // 将响应流pipe到输出流，支持解压
        if (inflate) {
            res.pipe(inflate).pipe(fetchRes);
            inflate.on('error', err => {
                _markFinishedWithError(finishedFlag, fetchRes, err, url);
                req.destroy();
            });
        }
        else res.pipe(fetchRes);
    });

    // 发送请求体（如果有）
    setImmediate(() => {
        const body = bodyResult.body;
        if (body) {
            try {
                if (typeof body.pipe === 'function') return body.pipe(req);
                else req.write(body);
            } catch (err) {
                _markFinishedWithError(finishedFlag, fetchRes, err, url);
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