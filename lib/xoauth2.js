'use strict';

const { Stream } = require('stream');
const { createSign } = require('crypto');
const { nmfetch, getLogger, resolveStream } = require('./shared');

/**
 * Gmail 的 XOAUTH2 access_token 生成器。
 * 在 Google API 控制台中为 Web 应用程序创建客户端 ID 以便使用此类。
 * 有关获取用户所需 refreshToken 的离线访问，请参阅离线访问
 * https://developers.google.com/accounts/docs/OAuth2WebServer#offline
 *
 * 使用 provisionCallback 自定义方法生成访问令牌的用法：
 * provisionCallback(user, renew, callback)
 *   * user 是要获取令牌的用户名
 *   * renew 是一个布尔值，如果为 true 表示现有令牌失败需要更新
 *   * callback 是带有 (error, accessToken [, expires]) 的回调函数
 *     * accessToken 是一个字符串
 *     * expires 是可选的过期时间（毫秒）
 * 如果使用了 provisionCallback，则 lunjack-mail 不会尝试自行生成令牌
 *
 * @constructor
 * @param {Object} options 令牌生成的客户端信息
 * @param {String} options.user 用户电子邮件地址
 * @param {String} options.clientId 客户端 ID 值
 * @param {String} options.clientSecret 客户端密钥值
 * @param {String} options.refreshToken 用户的刷新令牌
 * @param {String} options.accessUrl 令牌生成端点，默认为 'https://accounts.google.com/o/oauth2/token'
 * @param {String} options.accessToken 现有的有效访问令牌
 * @param {String} options.privateKey JWT 私钥
 * @param {Number} options.expires 可选的访问令牌过期时间（毫秒）
 * @param {Number} options.timeout 可选的访问令牌 TTL（秒）
 * @param {Function} options.provisionCallback 需要新访问令牌时运行的函数
 */
class XOAuth2 extends Stream {
    constructor(options = {}, logger) {
        super();
        this.options = options;

        const { privateKey, user, serviceRequestTimeout, component = 'OAuth2', provisionCallback, accessToken = '',
            expires, timeout, accessUrl, customHeaders = {}, customParams = {} } = this.options;
        // 服务账户验证
        if (this.options?.serviceClient) {
            if (!privateKey || !user) return setImmediate(() => this.emit('error', new Error('服务账户需要 "privateKey" 和 "user" 选项！')));
            this.options.serviceRequestTimeout = Math.min(Math.max(Number(serviceRequestTimeout) || 0, 0), 3600) || 5 * 60;
        }

        this.options.accessUrl = accessUrl || 'https://accounts.google.com/o/oauth2/token';
        this.options.customHeaders = customHeaders; this.options.customParams = customParams;
        this.accessToken = accessToken;
        this.renewing = false;  // 跟踪是否正在续订
        this.renewalQueue = []; // 续订期间待处理请求的队列
        this.logger = getLogger({ logger }, { component });
        this.provisionCallback = typeof provisionCallback === 'function' ? provisionCallback : false;

        const timeout_ = Math.max(Number(timeout) || 0, 0);
        // 如果指定了过期时间，则使用它，否则使用 TTL,否则，如果指定了 TTL，则使用它，否则使用默认值
        this.expires = expires && Number(expires) ? expires : (timeout_ && Date.now() + timeout_ * 1000) || 0;
    }

    /**
     * 返回或生成（如果之前的已过期）XOAuth2 令
     *
     * @param {Boolean} renew 如果为 false 则使用缓存的访问令牌（如果可用）
     * @param {Function} callback 带有错误对象和令牌字符串的回调函数
     */
    getToken(renew, callback) {
        const { user, refreshToken, serviceClient } = this.options;
        const { accessToken, xpires, provisionCallback, renewing } = this;
        // 重用令牌
        const reuseToken = message => {
            this.logger.debug({ tnx: 'OAUTH2', user, action: 'reuse' }, message, user);
            return callback(null, accessToken);
        };

        // 如果不需要续订且令牌有效，则直接重用
        if (!renew && accessToken && (!xpires || xpires > Date.now())) return reuseToken('为 %s 重用现有访问令牌');

        // 检查是否可以续订，如果不能，返回当前令牌或错误
        if (!provisionCallback && !refreshToken && !serviceClient) {
            if (accessToken) return reuseToken('为 %s 重用现有访问令牌（无刷新能力）');
            this.logger.error({ tnx: 'OAUTH2', user, action: 'renew' }, '无法为 %s 续订访问令牌：无可用刷新机制', user);
            return callback(new Error("无法为用户创建新的访问令牌"));
        }

        // 如果已经在续订中，将此请求加入队列而不是开始另一个
        if (renewing) return this.renewalQueue.push({ renew, callback });
        this.renewing = true;

        // 处理令牌续订完成 - 处理队列中的请求并清理
        const generateCallback = (err, accessToken) => {
            this.renewalQueue.forEach(item => item.callback(err, accessToken));
            this.renewalQueue = [], this.renewing = false;

            if (err) this.logger.error({ err, tnx: 'OAUTH2', user, action: 'renew' }, '为 %s 生成新访问令牌失败', user);
            else this.logger.info({ tnx: 'OAUTH2', user, action: 'renew' }, '为 %s 生成新访问令牌', user);
            callback(err, accessToken);  // 完成原始请求
        };

        if (provisionCallback)
            provisionCallback(user, !!renew, (err, accessToken, expires = 0) => {
                if (!err && accessToken) this.accessToken = accessToken, this.expires = expires;
                generateCallback(err, accessToken);
            });
        else this.generateToken(generateCallback);
    }

    /**
     * 更新令牌值
     *
     * @param {String} accessToken 新的访问令牌
     * @param {Number} timeout 访问令牌生命周期（秒）
     *
     * 触发 'token' 事件：{ user: 用户电子邮件地址, accessToken: 新的访问令牌, timeout: TTL（秒）}
     */
    updateToken(accessToken = '', timeout) {
        this.accessToken = accessToken;
        timeout = Math.max(Number(timeout) || 0, 0);
        this.expires = (timeout && Date.now() + timeout * 1000) || 0;
        this.emit('token', { user: this.options.user, accessToken, expires: this.expires });
    }

    /**
     * 使用初始化时提供的凭据生成新的 XOAuth2 令牌
     *
     * @param {Function} callback 带有错误对象和令牌字符串的回调函数
     */
    generateToken(callback) {
        let urlOptions, loggedUrlOptions;
        const { serviceClient, scope = 'https://mail.google.com/', user, serviceRequestTimeout, clientId = '',
            clientSecret, refreshToken = '', accessUrl, customParams } = this.options;
        if (serviceClient) {
            // 服务账户 - https://developers.google.com/identity/protocols/OAuth2ServiceAccount
            const iat = Math.floor(Date.now() / 1000); // unix 时间
            const tokenData = { iss: serviceClient, scope, sub: user, aud: accessUrl, iat, exp: iat + serviceRequestTimeout };
            let assertion;
            try {
                assertion = this.jwtSignRS256(tokenData);
            } catch (err) {
                return callback(new Error("无法生成令牌。请检查您的身份验证选项"));
            }
            const grant_type = 'urn:ietf:params:oauth:grant-type:jwt-bearer';
            urlOptions = { grant_type, assertion };
            loggedUrlOptions = { grant_type, assertion: tokenData };
        }
        else {
            if (!refreshToken) return callback(new Error("无法为用户创建新的访问令牌"));
            const grant_type = 'refresh_token';
            // Web 应用程序 - https://developers.google.com/identity/protocols/OAuth2WebServer
            urlOptions = { client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type };

            loggedUrlOptions = {
                client_id: clientId, client_secret: `${clientSecret.slice(0, 6)}...`,
                refresh_token: `${clientSecret.slice(0, 6)}...`, grant_type
            };
        }

        // 添加自定义参数
        Object.assign(urlOptions, customParams), Object.assign(loggedUrlOptions, customParams);
        const tnx = 'OAUTH2', action = 'post';
        this.logger.debug({ tnx, user, action: 'generate' }, '请求令牌使用: %s', JSON.stringify(loggedUrlOptions));

        this.postRequest(accessUrl, urlOptions, this.options, (error, body = '') => {
            if (error) return callback(error);
            let data;
            try {
                data = JSON.parse(body.toString());
            } catch (E) {
                return callback(E);
            }

            if (!data || typeof data !== 'object') {
                this.logger.debug({ tnx, user, action }, '响应: %s', body.toString());
                return callback(new Error('无效的身份验证响应'));
            }

            // 记录响应数据（隐藏访问令牌的完整内容）
            const logData = Object.fromEntries(
                Object.entries(data).map(([k, v = '']) => [k, k === 'access_token' ? `${v.toString().slice(0, 6)}...` : v])
            );

            this.logger.debug({ tnx, user, action }, '响应: %s', JSON.stringify(logData));

            if (data.error) {
                let errorMessage = data.error; // 错误响应：https://tools.ietf.org/html/rfc6749#section-5.2

                if (data.error_description) errorMessage += `: ${data.error_description}`;
                if (data.error_uri) errorMessage += ` (${data.error_uri})`;

                return callback(new Error(errorMessage));
            }

            if (data.access_token) {
                this.updateToken(data.access_token, data.expires_in);
                return callback(null, this.accessToken);
            }

            return callback(new Error('没有访问令牌'));
        });
    }

    /**
     * 将 access_token 和用户 ID 转换为 base64 编码的 XOAuth2 令牌
     *
     * @param {String} [accessToken] 访问令牌字符串
     * @return {String} 用于 IMAP 或 SMTP 登录的 Base64 编码令牌
     */
    buildXOAuth2Token(accessToken) {
        const authData = [`user=${(this.options.user || '')}`, `auth=Bearer ${(accessToken || this.accessToken)}`, '', ''];
        return Buffer.from(authData.join('\x01'), 'utf-8').toString('base64');
    }

    /**
     * 自定义 POST 请求处理程序。
     * 这仅在需要保持 Windows 中路径短时才需要;通常此模块
     * 是依赖项的依赖项，如果它尝试 require 某些东西
     * 比如 request 模块，路径对 Windows 来说会变得太长而无法处理。
     * 由于只进行简单的 POST 请求，所以实际上不需要复杂的
     * 逻辑支持（没有重定向，没有其他任何东西）。
     *
     * @param {String} url 要 POST 的 URL
     * @param {String|Buffer} payload 要 POST 的有效负载
     * @param {Function} callback 带有 (err, buff) 的回调函数
     */
    postRequest(url, payload, params, callback) {
        const req = nmfetch(url, { method: 'post', headers: params.customHeaders, body: payload, allowErrorResponse: true });
        resolveStream(req, callback); // 将流数据读取到Buffer中
    }

    /**
     * 将缓冲区或字符串编码为 Base64url 格式
     *
     * @param {Buffer|String} data 要转换的数据
     * @return {String} 编码后的字符串
     */
    toBase64URL(data) {
        if (typeof data === 'string') data = Buffer.from(data);

        return data.toString('base64')
            .replace(/[=]+/g, '') // 移除 '='
            .replace(/\+/g, '-') // '+' → '-'
            .replace(/\//g, '_'); // '/' → '_'
    }

    /**
     * 创建使用 RS256 (SHA256 + RSA) 签名的 JSON Web Token
     *
     * @param {Object} payload 要包含在生成令牌中的有效负载
     * @return {String} 生成并签名的令牌
     */
    jwtSignRS256(payload) {
        payload = ['{"alg":"RS256","typ":"JWT"}', JSON.stringify(payload)].map(val => this.toBase64URL(val)).join('.');
        const signature = createSign('RSA-SHA256').update(payload).sign(this.options.privateKey);
        return `${payload}.${this.toBase64URL(signature)}`;
    }
}

module.exports = XOAuth2;