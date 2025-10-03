'use strict';

/**
 * 最小化的 HTTP/S 代理客户端
 */

const net = require('net');
const tls = require('tls');

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
        return callback(new Error('无效的代理URL: ' + err.message));
    }

    // 创建到代理服务器的socket连接
    let options;
    let connect;
    let socket;

    // 配置连接选项
    options = {
        host: proxy.hostname,
        port: Number(proxy.port) || (proxy.protocol === 'https:' ? 443 : 80)
    };

    // 根据代理协议类型选择连接方式
    if (proxy.protocol === 'https:') {
        // 对于HTTPS代理，我们可以使用不受信任的代理，只要验证实际的SMTP证书
        options.rejectUnauthorized = false;
        connect = tls.connect.bind(tls);
    }
    else connect = net.connect.bind(net);


    // 初始连接的错误处理。一旦连接建立，错误处理责任将传递给socket使用者
    let finished = false;
    let tempSocketErr = err => {
        if (finished) return;

        finished = true;
        try {
            socket.destroy();
        } catch (E) { }
        callback(err);
    };

    // 超时错误处理
    let timeoutErr = () => {
        let err = new Error('代理socket连接超时');
        err.code = 'ETIMEDOUT';
        tempSocketErr(err);
    };

    // 建立到代理服务器的连接
    socket = connect(options, () => {
        if (finished) return;

        // 构造CONNECT请求头
        let reqHeaders = {
            Host: destinationHost + ':' + destinationPort,  // 目标主机和端口
            Connection: 'close'  // 连接类型
        };
        // 如果代理需要认证，添加认证头
        if (proxy.username || proxy.password) {
            const auth = (proxy.username || '') + ':' + (proxy.password || '');
            reqHeaders['Proxy-Authorization'] = 'Basic ' + Buffer.from(auth).toString('base64');
        }

        // 发送CONNECT请求到代理服务器
        socket.write(
            // HTTP方法
            'CONNECT ' + destinationHost + ':' + destinationPort + ' HTTP/1.1\r\n' +
            // HTTP请求头
            Object.keys(reqHeaders)
                .map(key => key + ': ' + reqHeaders[key])
                .join('\r\n') + '\r\n\r\n'  // 请求结束
        );

        // 处理代理服务器响应
        let headers = '';
        let onSocketData = chunk => {
            let match;
            let remainder;

            if (finished) return;

            headers += chunk.toString('binary');
            // 检查是否收到完整的HTTP头（以\r\n\r\n结尾）
            if ((match = headers.match(/\r\n\r\n/))) {
                socket.removeListener('data', onSocketData);

                const headersEndIndex = match.index + match[0].length;
                remainder = headers.substring(headersEndIndex);
                headers = headers.substring(0, match.index);

                // 将剩余数据推回socket缓冲区
                if (remainder) socket.unshift(Buffer.from(remainder, 'binary'));

                // 标记代理连接已建立
                finished = true;

                // 检查响应状态码
                match = headers.match(/^HTTP\/\d+\.\d+ (\d+)/i);
                if (!match || (match[1] || '').charAt(0) !== '2') {
                    try {
                        socket.destroy();
                    } catch (E) {
                        // 忽略错误
                    }
                    return callback(new Error('代理服务器返回无效响应' + ((match && ': ' + match[1]) || '')));
                }

                // 移除临时错误监听器
                socket.removeListener('error', tempSocketErr);
                socket.removeListener('timeout', timeoutErr);
                socket.setTimeout(0);  // 禁用超时

                // 成功回调，返回socket对象
                return callback(null, socket);
            }
        };
        socket.on('data', onSocketData);
    });

    // 设置连接超时
    socket.setTimeout(httpProxyClient.timeout || 30 * 1000);
    socket.on('timeout', timeoutErr);

    // 监听连接错误
    socket.once('error', tempSocketErr);
}

module.exports = httpProxyClient;