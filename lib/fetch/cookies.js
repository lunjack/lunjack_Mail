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
    constructor(options) {
        this.options = options || {}; // 初始化配置
        this.cookies = []; // 存储Cookie的数组
    }

    /**
     * 将Cookie字符串存储到Cookie存储中
     *
     * @param {String} cookieStr 来自'Set-Cookie:'头的值
     * @param {String} url 当前URL
     */
    set(cookieStr, url) {
        let urlObj;
        try {
            urlObj = new URL(url || '');
        } catch (e) {
            // 如果URL无效，使用默认值或抛出错误
            throw new Error('Invalid URL provided');
        }

        let cookie = this.parse(cookieStr); // 解析Cookie字符串
        let domain;

        // 处理Cookie的域名
        if (cookie.domain) {
            domain = cookie.domain.replace(/^\./, ''); // 移除域名前的点

            // 不允许跨域Cookie(如果请求的域名长度小于当前主机名，或者域名不匹配)
            if (urlObj.hostname.length < domain.length || ('.' + urlObj.hostname).slice(-domain.length + 1) !== '.' + domain)
                cookie.domain = urlObj.hostname; // 使用URL的主机名作为域名
        }
        else cookie.domain = urlObj.hostname; // 如果没有设置域名，使用URL的主机名

        // 如果没有设置路径，使用URL的路径
        if (!cookie.path) cookie.path = this.getPath(urlObj.pathname);

        // 如果没有过期时间，使用会话超时时间
        if (!cookie.expires)
            cookie.expires = new Date(Date.now() + (Number(this.options.sessionTimeout || SESSION_TIMEOUT) || SESSION_TIMEOUT) * 1000);

        return this.add(cookie); // 添加Cookie到存储
    }

    /**
     * 获取适用于指定URL的Cookie字符串，用于'Cookie:'请求头
     *
     * @param {String} url 要检查的URL
     * @returns {String} Cookie头字符串，如果没有匹配则返回空字符串
     */
    get(url) {
        return this.list(url)
            .map(cookie => cookie.name + '=' + cookie.value) // 将Cookie对象转换为name=value格式
            .join('; '); // 用分号和空格连接所有Cookie
    }

    /**
     * 列出适用于指定URL的所有有效Cookie对象
     *
     * @param {String} url 要检查的URL
     * @returns {Array} Cookie对象数组
     */
    list(url) {
        let result = [];
        let i;
        let cookie;

        // 倒序遍历Cookie数组（便于删除过期Cookie）
        for (i = this.cookies.length - 1; i >= 0; i--) {
            cookie = this.cookies[i];

            // 检查Cookie是否过期
            if (this.isExpired(cookie)) {
                this.cookies.splice(i, i); // 移除过期Cookie
                continue;
            }

            // 如果Cookie否匹配URL,则将匹配的Cookie添加到结果数组开头
            if (this.match(cookie, url)) result.unshift(cookie);
        }

        return result;
    }

    /**
     * 解析来自'Set-Cookie:'头的Cookie字符串
     *
     * @param {String} cookieStr 来自'Set-Cookie:'头的字符串
     * @returns {Object} Cookie对象
     */
    parse(cookieStr) {
        let cookie = {}; // 初始化空Cookie对象

        (cookieStr || '')
            .toString()
            .split(';') // 按分号分割Cookie字符串
            .forEach(cookiePart => {
                let valueParts = cookiePart.split('='); // 按等号分割键值对
                let key = valueParts.shift().trim().toLowerCase(); // 获取键名并规范化
                let value = valueParts.join('=').trim(); // 获取值
                let domain;

                if (!key) return; // 如果键名为空则跳过

                // 根据键名处理不同的Cookie属性
                switch (key) {
                    case 'expires': // 过期时间
                        value = new Date(value);
                        // 如果日期解析失败则忽略
                        if (value.toString() !== 'Invalid Date') cookie.expires = value;
                        break;

                    case 'path': // 路径
                        cookie.path = value;
                        break;

                    case 'domain': // 域名
                        domain = value.toLowerCase();
                        // 如果域名存在且没有前导点，则添加前导点
                        if (domain.length && domain.charAt(0) !== '.') domain = '.' + domain;
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
                        if (!cookie.name) {
                            cookie.name = key;
                            cookie.value = value;
                        }
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
        let urlObj;
        try {
            urlObj = new URL(url || '');
        } catch (e) {
            return false;// 如果URL无效，返回不匹配
        }

        // 检查主机名是否匹配
        // .foo.com 匹配子域名，foo.com 不匹配子域名
        if (urlObj.hostname !== cookie.domain &&
            (cookie.domain.charAt(0) !== '.' || ('.' + urlObj.hostname).slice(-cookie.domain.length) !== cookie.domain)
        ) return false;

        // 检查路径是否匹配
        let path = this.getPath(urlObj.pathname);

        // 如果路径不以Cookie路径开头，则不匹配
        if (!path.startsWith(cookie.path)) return false;
        // 如果Cookie是安全的但URL不是https，则不匹配
        if (cookie.secure && urlObj.protocol !== 'https:') return false;

        return true;
    }

    /**
     * 添加（或更新/删除）Cookie对象到Cookie存储
     *
     * @param {Object} cookie 要存储的Cookie值
     */
    add(cookie) {
        let i;
        let len;

        // 如果Cookie无效则直接返回
        if (!cookie || !cookie.name) return false;

        // 检查是否有相同参数的Cookie（用于更新）
        for (i = 0, len = this.cookies.length; i < len; i++) {
            if (this.compare(this.cookies[i], cookie)) {
                // 检查是否需要删除Cookie（如果已过期）
                if (this.isExpired(cookie)) {
                    this.cookies.splice(i, 1);
                    return false;
                }

                this.cookies[i] = cookie; // 更新现有Cookie
                return true;
            }
        }

        // 如果没有过期，则添加为新Cookie
        if (!this.isExpired(cookie)) this.cookies.push(cookie);

        return true;
    }

    /**
     * 检查两个Cookie对象是否相同
     *
     * @param {Object} a 要比较的Cookie
     * @param {Object} b 要比较的Cookie
     * @returns {Boolean} 如果Cookie相同则返回true
     */
    compare(a, b) {
        return a.name === b.name && a.path === b.path && a.domain === b.domain && a.secure === b.secure && a.httponly === a.httponly;
    }

    /**
     * 检查Cookie是否已过期
     *
     * @param {Object} cookie 要检查的Cookie对象
     * @returns {Boolean} 如果Cookie已过期则返回true
     */
    isExpired(cookie) {
        return (cookie.expires && cookie.expires < new Date()) || !cookie.value;
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
        const lastSlash = path.lastIndexOf('/');
        path = path.substring(0, lastSlash + 1);

        // 确保以/开头
        return path.startsWith('/') ? path : '/' + path;
    }
}

// 导出Cookies类
module.exports = Cookies;