'use strict';

/**
 * 最小化的 HTTP/S 代理客户端
 */

const NET = require('net');
const TLS = require('tls');
const { regexs } = require('./regexs');

/**
 * 建立到目标端口的代理连接
 *
 * 使用示例：
 * httpProxyClient("http://localhost:3128/", 80, "google.com", function(err, socket){
 *     socket.write("GET / HTTP/1.0\r\n\r\n");
 * });
 *
 * @param {String} proxyUrl 代理配置，例如 "http://proxy.host:3128/"
 * @param {Number} destinationPort 目标主机端口
 * @param {String} destinationHost 目标主机名
 * @param {Function} callback 连接建立后的回调函数，接收socket对象
 */
function httpProxyClient(proxyUrl, destinationPort, destinationHost, callback) {
    let proxy;
    try {
        proxy = new URL(proxyUrl);
    } catch (err) {
        return callback(new Error(`无效的代理URL:${err.message}`));
    }

    const { hostname, port, protocol, username = '', password = '' } = proxy, isHttps = protocol === 'https:',
        options = { host: hostname, port: Number(port) || (isHttps ? 443 : 80), rejectUnauthorized: !isHttps }, // 配置连接选项
        connect = isHttps ? TLS.connect.bind(TLS) : NET.connect.bind(NET), // 根据代理协议类型选择连接方式
        state = { finished: false };
    function tempSocketErr(err) {
        if (state.finished) return;
        state.finished = true;

        try {
            socket.destroy();
        } catch (E) { }
        callback(err);
    };

    // 超时错误处理
    function timeoutErr() {
        let err = new Error('代理socket连接超时');
        err.code = 'ETIMEDOUT', tempSocketErr(err);
    };

    // 建立到代理服务器的连接
    const socket = connect(options, () => {
        if (state.finished) return;

        // 构造CONNECT请求头(目标主机和端口,连接类型)
        const reqHeaders = { Host: `${destinationHost}:${destinationPort}`, Connection: 'close' };
        // 如果代理需要认证，添加认证头
        if (username || password) {
            const auth = `${username}:${password}`;
            reqHeaders['Proxy-Authorization'] = `Basic ${Buffer.from(auth).toString('base64')}`;
        }

        // 发送CONNECT请求到代理服务器
        socket.write(`CONNECT ${destinationHost}:${destinationPort} HTTP/1.1\r\n${Object.keys(reqHeaders)
            .map(key => `${key}: ${reqHeaders[key]}`).join('\r\n')}\r\n\r\n`);

        let headerChunks = [];
        // 处理代理服务器响应
        function onSocketData(chunk) {
            if (state.finished) return;

            headerChunks.push(chunk);  // 使用数组累积数据块
            const headers = Buffer.concat(headerChunks).toString('binary'), headersEndIndex = headers.indexOf('\r\n\r\n');
            if (headersEndIndex !== -1) {
                socket.removeListener('data', onSocketData);

                const remainder = headers.substring(headersEndIndex + 4), headerPart = headers.substring(0, headersEndIndex),
                    statusMatch = headerPart.match(regexs.HTTP_RESPONSE_STATUS_LINE);

                if (remainder) socket.unshift(Buffer.from(remainder, 'binary'));
                state.finished = true;
                if (!statusMatch || (statusMatch[1]?.[0] ?? '') !== '2') {
                    try { socket.destroy(); } catch (E) { }
                    headerChunks = [];
                    return callback(new Error(`代理服务器返回无效响应${((statusMatch && `: ${statusMatch[1]}`) || '')}`));
                }

                socket.removeListener('error', tempSocketErr).removeListener('timeout', timeoutErr).setTimeout(0);
                headerChunks = []; // 成功时重置 headerChunks
                return callback(null, socket);
            }
        }
        socket.on('data', onSocketData);
    });

    socket.setTimeout(httpProxyClient.timeout || 30 * 1000).on('timeout', timeoutErr).once('error', tempSocketErr);//监听连接错误
}

module.exports = httpProxyClient;