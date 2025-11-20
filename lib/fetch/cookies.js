'use strict';

// Cookie处理模块
const SESSION_TIMEOUT = 1800; // 会话默认超时时间：30分钟（1800秒）

/**
 * 创建一个Biskviit Cookie存储容器，用于内存中的Cookie管理
 *
 * @constructor
 * @param {Object} [options] 可选的配置对象
 */
class Cookies {
    constructor(options = {}) {
        this.options = options, this.cookies = [];
    }

    // 检查主机名是否匹配Cookie域名
    _isDomainMatch(hostname, domain) {
        if (hostname === domain) return true; // 精确匹配
        // 如果域名以点开头，则匹配所有子域名,否则返回false
        return domain.startsWith('.') ? (`.${hostname}`).endsWith(domain) : false;
    }

    /**
     * 尝试将给定的字符串解析为URL对象
     * @param {string} str - 需要解析的URL字符串，默认为空字符串
     * @returns {URL|boolean} 如果解析成功返回URL对象，否则返回false
     */
    _newURL(str = '') {
        try {
            return str = new URL(str);
        } catch (e) {
            return false;
        }
    }

    /**
     * 将Cookie字符串存储到Cookie存储中
     *
     * @param {String} cookieStr 来自'Set-Cookie:'头的值
     * @param {String} url 当前URL
     */
    set(cookieStr, url) {
        const urlObj = _newURL(str)
        if (!urlObj) throw new Error('提供的URL无效');

        const cookie = this.parse(cookieStr), // 解析Cookie字符串
            { hostname, pathname } = urlObj, { domain, path, expires } = cookie;

        // 当域名不存在时或域名存在但不匹配时，直接使用主机名;否则当域名存在且匹配时，保留原始值
        cookie.domain = !domain || !this._isDomainMatch(hostname, domain) ? hostname : domain;

        if (!path) cookie.path = this.getPath(pathname);  // 如果没有设置路径，使用URL的路径
        // 如果没有过期时间，使用会话超时时间
        if (!expires) cookie.expires = new Date(Date.now() + Number(this.options.sessionTimeout ?? SESSION_TIMEOUT) * 1000);

        return this.add(cookie); // 添加Cookie到存储
    }

    /**
     * 获取适用于指定URL的Cookie字符串，用于'Cookie:'请求头
     *
     * @param {String} url 要检查的URL
     * @returns {String} Cookie头字符串，如果没有匹配则返回空字符串
     */
    get(url) {
        // 将Cookie对象转换为name=value格式,用分号和空格连接所有Cookie
        return this.list(url).map(cookie => `${cookie.name}=${cookie.value}`).join('; ');
    }

    /**
     * 列出适用于指定URL的所有有效Cookie对象
     *
     * @param {String} url 要检查的URL
     * @returns {Array} Cookie对象数组
     */
    list(url) {
        const result = [];
        let cookie;

        // 倒序遍历Cookie数组（便于删除过期Cookie）
        for (let i = this.cookies.length - 1; i >= 0; i--) {
            cookie = this.cookies[i];

            // 检查Cookie是否过期
            if (this.isExpired(cookie)) {
                this.cookies.splice(i, 1);                      // 移除过期Cookie
                continue;
            }
            if (this.match(cookie, url)) result.unshift(cookie); // 如果Cookie匹配URL,则将匹配的Cookie添加到结果数组开头
        }

        return result;
    }

    /**
     * 解析来自'Set-Cookie:'头的Cookie字符串
     *
     * @param {String} cookieStr 来自'Set-Cookie:'头的字符串
     * @returns {Object} Cookie对象
     */
    parse(cookieStr = '') {
        const cookie = {}; // 初始化空Cookie对象

        cookieStr.toString().split(';')
            .forEach(cookiePart => {
                // 按等号分割键值对,获取键名并规范化并获取值
                const valueParts = cookiePart.split('='), key = valueParts.shift().trim().toLowerCase();
                let value = valueParts.join('=').trim(), domain;

                if (!key) return; // 如果键名为空则跳过
                // 根据键名处理不同的Cookie属性
                switch (key) {
                    case 'expires': // 过期时间
                        value = new Date(value);
                        if (value.toString() !== 'Invalid Date') cookie.expires = value; // 如果日期解析失败则忽略
                        break;
                    case 'path':
                        cookie.path = value;
                        break;
                    case 'domain': // 域名
                        domain = value.toLowerCase();
                        // 如果域名存在且没有前导点，则添加前导点
                        if (domain.length && !domain.startsWith('.')) domain = `.${domain}`;
                        cookie.domain = domain;
                        break;
                    case 'max-age': // 最大存活时间（秒）
                        cookie.expires = new Date(Date.now() + (Number(value) || 0) * 1000);
                        break;
                    case 'secure': // 安全标志
                        cookie.secure = true;
                        break;
                    case 'httponly': // 仅HTTP标志
                        cookie.httponly = true;
                        break;
                    default:
                        // 如果没有匹配的属性，则默认处理Cookie的名称和值
                        if (!cookie.name) cookie.name = key, cookie.value = value;
                }
            });

        return cookie;
    }

    /**
     * 检查Cookie对象是否适用于指定URL
     *
     * @param {Object} cookie Cookie对象
     * @param {String} url 要检查的URL
     * @returns {Boolean} 如果Cookie适用于指定URL则返回true
     */
    match(cookie, url) {
        const urlObj = _newURL(str)
        if (!urlObj) return false;
        if (!this._isDomainMatch(urlObj.hostname, cookie.domain)) return false; // 检查主机名是否不匹配Cookie域名

        const path = this.getPath(urlObj.pathname);                             // 检查路径是否匹配
        if (!path.startsWith(cookie.path)) return false;                        // 如果路径不以Cookie路径开头，则不匹配
        return cookie.secure && urlObj.protocol !== 'https:' ? false : true; // 如果Cookie是安全的但URL不是https，则不匹配,否则匹配
    }

    /**
     * 添加（或更新/删除）Cookie对象到Cookie存储
     *
     * @param {Object} cookie 要存储的Cookie值
     */
    add(cookie) {
        if (!cookie || !cookie.name) return false; // 如果Cookie无效则直接返回

        // 检查是否有相同参数的Cookie（用于更新）
        for (let i = 0; i < this.cookies.length; i++) {
            if (this.compare(this.cookies[i], cookie)) {
                // 检查是否需要删除Cookie（如果已过期）
                if (this.isExpired(cookie)) {
                    this.cookies.splice(i, 1);
                    return false;
                }

                this.cookies[i] = cookie;           // 更新现有Cookie
                return true;
            }
        }

        if (!this.isExpired(cookie)) this.cookies.push(cookie); // 如果没有过期，则添加为新Cookie
        return true;
    }

    /**
     * 检查两个Cookie对象是否相同
     *
     * @param {Object} a Cookie-对象a
     * @param {Object} b Cookie-对象b
     * @returns {Boolean} 如果Cookie相同则返回true
     */
    compare(a, b) {
        return ['name', 'path', 'domain', 'secure', 'httponly'].every(key => a[key] === b[key]);
    }

    /**
     * 检查Cookie是否已过期
     *
     * @param {Object} cookie 要检查的Cookie对象
     * @returns {Boolean} 如果Cookie已过期则返回true
     */
    isExpired(cookie) {
        return !cookie.value || (cookie.expires?.getTime() < Date.now())
    }

    /**
     * 返回URL路径参数的规范化Cookie路径
     *
     * @param {String} pathname 路径名
     * @returns {String} 规范化后的路径
     */
    getPath(pathname) {
        let path = pathname || '/'; // 处理空值，默认为根路径

        // 直接找到最后一个斜杠的位置，保留到该位置（包含斜杠）
        const lastIndex = path.lastIndexOf('/');
        path = path.substring(0, lastIndex + 1);

        return path.startsWith('/') ? path : `/${path}`; // 确保以/开头
    }
}

// 导出Cookies类
module.exports = Cookies;