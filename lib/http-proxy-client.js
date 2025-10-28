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

    const { hostname, port, protocol, username, password } = proxy, isHttps = protocol === 'https:';
    // 配置连接选项
    const options = { host: hostname, port: Number(port) || (isHttps ? 443 : 80), rejectUnauthorized: !isHttps };

    const connect = isHttps ? TLS.connect.bind(TLS) : NET.connect.bind(NET); // 根据代理协议类型选择连接方式
    let finished = false; // 初始连接的错误处理:一旦连接建立,错误处理将传递给socket使用者
    function tempSocketErr(err) {
        if (finished) return;
        finished = true;

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
        if (finished) return;

        // 构造CONNECT请求头(目标主机和端口,连接类型)
        const reqHeaders = { Host: `${destinationHost}:${destinationPort}`, Connection: 'close' };
        // 如果代理需要认证，添加认证头
        if (username || password) {
            const auth = `${(username || '')}:${(password || '')}`;
            reqHeaders['Proxy-Authorization'] = `Basic ${Buffer.from(auth).toString('base64')}`;
        }

        // 发送CONNECT请求到代理服务器
        socket.write(`CONNECT ${destinationHost}:${destinationPort} HTTP/1.1\r\n${Object.keys(reqHeaders)
            .map(key => `${key}: ${reqHeaders[key]}`)
            .join('\r\n')}\r\n\r\n`);

        // 处理代理服务器响应
        function onSocketData(chunk) {
            let match, headers = ''

            if (finished) return;
            headers += chunk.toString('binary');
            // 检查是否收到完整的HTTP头（以\r\n\r\n结尾）
            if ((match = headers.match(regexs.HTTP_HEADER_END))) {
                socket.removeListener('data', onSocketData);

                const headersEndIndex = match.index + match[0].length;
                const remainder = headers.substring(headersEndIndex);
                headers = headers.substring(0, match.index);

                // 将剩余数据推回socket缓冲区
                if (remainder) socket.unshift(Buffer.from(remainder, 'binary'));
                finished = true;                                          // 标记代理连接已建立
                match = headers.match(regexs.HTTP_RESPONSE_STATUS_LINE);  // 检查响应状态码
                if (!match || (match[1]?.[0] ?? '') !== '2') {
                    try {
                        socket.destroy();
                    } catch (E) { }
                    return callback(new Error(`代理服务器返回无效响应${((match && `: ${match[1]}`) || '')}`));
                }

                // 移除临时错误监听器
                socket.removeListener('error', tempSocketErr).removeListener('timeout', timeoutErr);
                socket.setTimeout(0);           // 禁用超时

                return callback(null, socket);  // 成功回调，返回socket对象
            }
        };
        socket.on('data', onSocketData);
    });

    socket.setTimeout(httpProxyClient.timeout || 30 * 1000);       // 设置连接超时
    socket.on('timeout', timeoutErr).once('error', tempSocketErr); // 监听连接错误
}

module.exports = httpProxyClient;