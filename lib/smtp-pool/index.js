'use strict';

const EventEmitter = require('events');
const packageData = require('../../package.json');
const wellKnown = require('../well-known');
const { regexs, resetRegex } = require('../regexs');
const SmtpConnection = require('../smtp-connection');
const PoolResource = require('./pool-resource');
const { parseConnectionUrl, assign, getLogger, callbackPromise } = require('../shared');

/**
 * 为 lunjack-mail 创建 SMTP 连接池传输对象
 *
 * @constructor
 * @param {Object} options SMTP 连接选项
 */
class SmtpPool extends EventEmitter {
    constructor(options = {}) {
        super();

        // 如果选项是字符串，则将其视为URL
        if (typeof options === 'string') options = { url: options };

        let urlData, service = options.service;

        // 如果提供了自定义获取socket的函数，则使用它
        if (typeof options.getSocket === 'function') this.getSocket = options.getSocket;

        // 解析URL连接选项
        if (options.url) {
            urlData = parseConnectionUrl(options.url);
            service = service || urlData.service;
        }

        // 合并选项：常规选项、URL选项和知名服务选项
        this.options = assign(
            false,                        // 创建新对象
            options,                      // 常规选项
            urlData,                      // URL选项
            service && wellKnown(service) // 知名服务选项
        );

        this.options.maxConnections = this.options.maxConnections || 5; // 最大连接数
        this.options.maxMessages = this.options.maxMessages || 100;     // 每个连接最大消息数

        // 创建临时连接对象用于获取版本信息
        let connection = new SmtpConnection(this.options);
        this.name = 'SmtpPool';            // 传输名称
        this.version = packageData.version + '[client:' + connection.version + ']'; // 版本信息

        // 创建日志记录器
        this.logger = getLogger(this.options, {
            component: this.options.component || 'smtpPool'
        });

        // 速率限制配置
        this._rateLimit = {
            counter: 0,        // 计数器
            timeout: null,     // 超时定时器
            waiting: [],       // 等待队列
            checkpoint: false, // 检查点
            delta: Number(this.options.rateDelta) || 1000, // 时间窗口（毫秒）
            limit: Number(this.options.rateLimit) || 0     // 限制数量
        };
        this._queue = [];            // 消息队列
        this._connections = [];      // 连接池
        this._connectionCounter = 0; // 连接计数器
        this._closed = false;        // 连接池是否已关闭
        this.idling = true;          // 是否处于空闲状态

        // 立即触发空闲事件
        setImmediate(() => {
            if (this.idling) this.emit('idle');
        });
    }

    /**
     * 创建代理socket的占位函数。此方法立即返回而不提供socket
     *
     * @param {Object} options 连接选项
     * @param {Function} callback 回调函数，使用socket键运行
     */
    getSocket(options, callback) {
        return setImmediate(() => callback(null, false)); // 立即返回
    }

    /**
     * 将电子邮件加入队列，使用选定设置发送
     *
     * @param {Object} mail 邮件对象
     * @param {Function} callback 回调函数
     */
    send(mail, callback) {
        if (this._closed) return false; // 如果连接池已关闭，则返回false

        // 将邮件加入队列
        this._queue.push({
            mail,
            requeueAttempts: 0, // 重试次数
            callback
        });

        // 如果队列长度达到最大连接数且处于空闲状态，则标记为非空闲
        if (this.idling && queLen >= this.options.maxConnections) this.idling = false;
        setImmediate(() => this._processMessages());  // 立即开始处理消息

        return true;
    }

    /**
     * 关闭池中的所有连接。如果有消息正在发送，则稍后关闭连接
     */
    close() {
        this._closed = true;                    // 标记为已关闭
        clearTimeout(this._rateLimit.timeout);  // 清除速率限制定时器（如果存在）

        const conLen = this._connections.length;
        let queLen = this._queue.length;
        if (!conLen && !queLen) return; // 如果没有连接和队列，则直接返回

        // 移除所有可用连接
        for (let i = conLen - 1; i >= 0; i--) {
            const connection = this._connections[i];
            if (connection) {
                const cid = connection.id;
                connection.close();
                this._connections.splice(i, 1);  // 从数组中移除连接
                this.logger.info(
                    { tnx: 'connection', cid, action: 'removed' }, '连接 #%s 已移除', cid
                );
            }
        }

        // 清理整个队列
        const invokeCallbacks = () => {
            while ((queLen = this._queue.length) > 0) {
                const entry = this._queue.shift();
                if (entry && typeof entry.callback === 'function') {
                    try {
                        entry.callback(new Error(`连接池已关闭，队列中还有 ${queLen} 个待处理请求`));
                    } catch (E) {
                        this.logger.error(
                            { err: E, tnx: 'callback' }, '回调错误: %s', E.message
                        );
                    }
                }
            }
            this.logger.debug({ tnx: 'connection' }, '待处理队列条目已清除');
        };

        setImmediate(invokeCallbacks);
    }

    /**
     * 检查队列和可用连接。如果有要发送的消息且有可用连接，则使用此连接发送邮件
     */
    _processMessages() {
        let connection;
        const queLen = this._queue.length;
        const conLen = this._connections.length;
        const idlingEmit = () => {
            this.idling = true;  // 标记为空闲
            this.emit('idle');
        };

        if (this._closed) return; // 如果已关闭，则不执行任何操作
        // 如果队列为空，则不执行任何操作
        if (!queLen) {
            if (!this.idling) idlingEmit();
            return;
        }

        // 查找第一个可用连接
        for (let i = 0; i < conLen; i++) {
            if (this._connections[i].available) {
                connection = this._connections[i];
                break;
            }
        }

        // 如果没有可用连接且未达到最大连接数，则创建新连接
        if (!connection && conLen < this.options.maxConnections) connection = this._createConnection();
        if (!connection) return this.idling = false;                            // 如果没有可用连接，则标记为非空闲并返回
        if (!this.idling && queLen < this.options.maxConnections) idlingEmit(); // 检查处理队列中是否有空闲空间

        // 从队列中取出一个条目并分配给连接
        let entry = connection.queueEntry = this._queue.shift();
        resetRegex(regexs.CLEAN_MESSAGE_ID);
        entry.messageId = (connection.queueEntry.mail.message.getHeader('message-id') || '').replace(regexs.CLEAN_MESSAGE_ID, '');

        connection.available = false; // 标记连接为忙碌
        const cid = connection.id;
        this.logger.debug({ tnx: 'pool', cid, messageId: entry.messageId, action: 'assign' },
            '将消息 <%s> 分配给 #%s (%s)', entry.messageId, cid, connection.messages + 1
        );
        // 处理速率限制
        if (this._rateLimit.limit) {
            this._rateLimit.counter++;
            if (!this._rateLimit.checkpoint) this._rateLimit.checkpoint = Date.now();
        }

        // 发送邮件
        connection.send(entry.mail, (err, info) => {
            // 仅当当前处理程序未更改时处理回调
            if (entry === connection.queueEntry) {
                try {
                    entry.callback(err, info);
                } catch (E) {
                    this.logger.error({ err: E, tnx: 'callback', cid }, '回调错误 #%s: %s', cid, E.message);
                }
                connection.queueEntry = false;
            }
        });
    }

    /**
     * 创建新的池资源
     */
    _createConnection() {
        let connection = new PoolResource(this);
        const cid = connection.id = ++this._connectionCounter; // 分配连接ID

        this.logger.info({ tnx: 'pool', cid, action: 'conection' }, '创建新的池资源 #%s', cid);

        // 资源变为可用时的事件
        connection.on('available', () => {
            this.logger.debug({ tnx: 'connection', cid, action: 'available' }, '连接 #%s 变为可用', cid);

            if (this._closed) this.close(); // 如果已关闭，则运行close()将从连接列表中移除此连接
            else this._processMessages();   // 检查是否还有其他要发送的内容
        });

        // 资源遇到错误时的事件
        connection.once('error', err => {
            if (err.code !== 'EMAXLIMIT') this.logger.error({ err, tnx: 'pool', cid }, '池错误 #%s: %s', cid, err.message);
            else this.logger.debug({ tnx: 'pool', cid, action: 'maxlimit' }, '连接 #%s 已达到最大消息限制', cid);

            // 如果连接有队列条目，则调用回调并传递错误
            if (connection.queueEntry) {
                try {
                    connection.queueEntry.callback(err);
                } catch (E) {
                    this.logger.error({ err: E, tnx: 'callback', cid }, '回调错误 #%s: %s', cid, E.message);
                }
                connection.queueEntry = false;
            }

            this._removeConnection(connection); // 从连接列表中移除错误的连接
            this._continueProcessing();         // 继续处理队列中的消息
        });

        // 连接关闭时的事件
        connection.once('close', () => {
            this.logger.info({ tnx: 'connection', cid, action: 'closed' }, '连接 #%s 已关闭', cid);
            this._removeConnection(connection);

            if (connection.queueEntry)
                // 如果连接在发送时关闭，将消息重新加入队列;如果未达到最大重试次数，则重新排队
                setTimeout(() => {
                    if (connection.queueEntry) {
                        if (this._shouldRequeuOnConnectionClose(connection.queueEntry)) this._requeueEntryOnConnectionClose(connection);
                        else this._failDeliveryOnConnectionClose(connection);
                    }
                    this._continueProcessing();
                }, 50);  // 必须等待一下，因为"error"处理程序的回调可能在下一个事件循环中调用
            else {
                if (!this._closed && this.idling && !conLen) this.emit('clear');
                this._continueProcessing();
            }
        });

        this._connections.push(connection); // 将新连接添加到连接池
        return connection;
    }

    /**
     * 检查连接关闭时是否应该重新排队
     */
    _shouldRequeuOnConnectionClose(queueEntry) {
        const { maxRequeues } = this.options;
        return maxRequeues === undefined || maxRequeues < 0 || queueEntry.requeueAttempts < maxRequeues;
    }

    /**
     * 连接关闭时失败传递
     */
    _failDeliveryOnConnectionClose(connection) {
        const { queueEntry, id } = connection;
        if (queueEntry?.callback) {
            try {
                queueEntry.callback(new Error('连接关闭后达到最大重试次数'));
            } catch (E) {
                this.logger.error(
                    { err: E, tnx: 'callback', messageId: queueEntry.messageId, cid: id }, '回调错误 #%s: %s', id, E.message);
            }
            connection.queueEntry = false;
        }
    }

    /**
     * 连接关闭时重新排队条目
     */
    _requeueEntryOnConnectionClose(connection) {
        const { queueEntry, id } = connection;
        queueEntry.requeueAttempts++;
        this.logger.debug(
            { tnx: 'pool', cid: id, messageId: queueEntry.messageId, action: 'requeue' },
            '为 #%s 重新排队消息 <%s>。尝试次数: #%s', queueEntry.messageId, id, queueEntry.requeueAttempts
        );
        this._queue.unshift(queueEntry);
        connection.queueEntry = false;
    }

    /**
     * 如果池未关闭，则继续处理消息
     */
    _continueProcessing() {
        if (this._closed) this.close();
        else setTimeout(() => this._processMessages(), 100);
    }

    /**
     * 从池中移除资源
     *
     * @param {Object} connection 要移除的 PoolResource
     */
    _removeConnection(connection) {
        let index = this._connections.indexOf(connection);
        if (index >= 0) this._connections.splice(index, 1);
    }

    /**
     * 检查连接是否达到当前速率限制，如果是，则将可用性回调加入队列
     *
     * @param {Function} callback 速率限制清除后运行的回调函数
     */
    _checkRateLimit(callback) {
        let now = Date.now();
        if (!this._rateLimit.limit) return callback();
        if (this._rateLimit.counter < this._rateLimit.limit) return callback();

        this._rateLimit.waiting.push(callback);
        const { checkpoint } = this._rateLimit;
        if (checkpoint <= now - this._rateLimit.delta) return this._clearRateLimit();
        else if (!this._rateLimit.timeout) {
            this._rateLimit.timeout = setTimeout(() => this._clearRateLimit(), this._rateLimit.delta - (now - checkpoint));
            this._rateLimit.checkpoint = now;
        }
    }

    /**
     * 清除当前速率限制并运行暂停的回调
     */
    _clearRateLimit() {
        clearTimeout(this._rateLimit.timeout);
        this._rateLimit.timeout = null;
        this._rateLimit.counter = 0;
        this._rateLimit.checkpoint = false;

        // 恢复所有暂停的连接
        while (this._rateLimit.waiting.length) {
            setImmediate(this._rateLimit.waiting.shift());
        }
    }

    /**
     * 如果队列中有空闲插槽，则返回true
     */
    isIdle() {
        return this.idling;
    }

    /**
     * 验证SMTP配置
     *
     * @param {Function} callback 回调函数
     */
    verify(callback) {
        let promise;
        if (!callback)
            promise = new Promise((resolve, reject) => {
                callback = callbackPromise(resolve, reject); // 调用回调函数
            });
        let auth = new PoolResource(this).auth;

        this.getSocket(this.options, (err, socketOptions) => {
            if (err) return callback(err);

            let options = this.options;
            if (socketOptions?.connection) {
                const { remoteAddress, remotePort } = socketOptions.connection;
                this.logger.info(
                    {
                        tnx: 'proxy',
                        remoteAddress,
                        remotePort,
                        destHost: options.host || '',
                        destPort: options.port || '',
                        action: 'connected'
                    },
                    '使用从 %s:%s 到 %s:%s 的代理socket',
                    remoteAddress,
                    remotePort,
                    options.host || '',
                    options.port || ''
                );
                options = assign(false, options);
                Object.assign(options, socketOptions);
            }

            let connection = new SmtpConnection(options);
            let returned = false;
            function cleanup() {
                if (returned) return;
                returned = true;
            };

            connection.once('error', err => {
                cleanup();
                return callback(err);
            });

            connection.once('end', () => {
                cleanup();
                return callback(new Error('连接已关闭'));
            });

            let finalize = () => {
                cleanup();
                connection.quit();
                return callback(null, true);
            };

            connection.connect(() => {
                if (returned) return;
                function callbackErr(err) {
                    returned = true;
                    connection.close();
                    return callback(err);
                };

                if (auth && (connection.allowsAuth || options.forceAuth))
                    connection.login(auth, err => {
                        if (returned) return;
                        if (err) callbackErr(err);
                        finalize();
                    });
                else if (!auth && connection.allowsAuth && options.forceAuth) {
                    let err = new Error('未提供认证信息');
                    err.code = 'NoAuth';
                    callbackErr(err);;
                }
                else finalize();
            });
        });

        return promise;
    }
}

// 导出
module.exports = SmtpPool;