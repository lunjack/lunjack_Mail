'use strict';

const { spawn } = require('child_process'); // 引入子进程生成模块
const packageData = require('../package.json');
const { getLogger, formatRecipients } = require('./shared');

/**
 * 生成Sendmail传输对象
 *
 * 可用的选项如下：
 *
 *  **path** sendmail二进制文件的可选路径
 *  **newline** 换行符类型，可以是'windows'或'unix'
 *  **args** sendmail二进制文件的参数数组
 *
 * @constructor
 * @param {Object} options Sendmail的可选配置参数
 */
class SendmailTransport {
    constructor(options = {}) {
        this._spawn = spawn;   // 使用spawn的引用，便于模拟测试
        this.options = options;
        this.name = 'SendmailTransport';
        this.version = packageData.version;
        this.path = 'sendmail'; // 默认sendmail路径
        this.args = false;      // 参数数组，默认为false
        this.winbreak = false;  // Windows换行标志，默认为false

        // 获取日志记录器
        this.logger = getLogger(this.options, {
            component: this.options.component || 'sendmail'
        });

        // 根据选项配置参数
        if (options) {
            if (typeof options === 'string') this.path = options;  // 如果options是字符串，直接作为sendmail路径
            // 否则,如果options是对象，检查path和args属性
            else if (typeof options === 'object') {
                if (options.path) this.path = options.path;
                if (Array.isArray(options.args)) this.args = options.args;
                // 检查是否使用Windows换行符
                this.winbreak = ['win', 'windows', 'dos', '\r\n'].includes((options.newline || '').toString().toLowerCase());
            }
        }
    }

    /**
     * <p>编译mailcomposer消息并将其转发给发送处理器</p>
     *
     * @param {Object} mail MailComposer对象
     * @param {Function} done 发送完成时运行的回调函数
     */
    send(mail, done) {
        mail.message.keepBcc = true;                                     // 保留Bcc字段
        let envelope = mail.data.envelope || mail.message.getEnvelope(); // 获取信封信息
        let messageId = mail.message.messageId();                        // 获取消息ID
        let args, sendmail, returned;
        const { from, to } = envelope;
        // 检查是否有无效的邮件地址（以连字符开头）
        const hasInvalidAddresses = (from || []).concat(to || []).some(addr => /^-/.test(addr));
        if (hasInvalidAddresses) return done(new Error('无法发送邮件。信封地址无效。'));

        // 如果指定了参数,添加-i参数以保持单点,否则如果指定了from,则添加-f参数,否则不添加
        args = this.args ? ['-i', ...this.args, ...to] : ['-i', ...(from ? ['-f', from] : []), ...to];

        // 定义回调函数
        let callback = err => {
            if (returned) return;
            returned = true;
            if (typeof done === 'function') {
                if (err) return done(err);
                else return done(null,
                    { envelope: mail.data.envelope || mail.message.getEnvelope(), messageId, response: '消息已排队等待投递' });
            }
        };

        try {
            sendmail = this._spawn(this.path, args); // 尝试生成sendmail子进程
        } catch (E) {
            // 记录生成sendmail进程时的错误
            this.logger.error({ err: E, tnx: 'spawn', messageId }, '生成sendmail时发生错误。%s', E.message);
            return callback(E);
        }

        if (sendmail) {
            // 处理sendmail进程错误
            sendmail.on('error', err => {
                this.logger.error({ err, tnx: 'spawn', messageId }, '发送消息%s时发生错误。%s', messageId, err.message);
                callback(err);
            });

            // 处理sendmail进程退出
            sendmail.once('exit', code => {
                if (!code) return callback();
                let err = code === 127 ? new Error('未找到Sendmail命令，进程退出代码：' + code) : new Error('Sendmail退出代码：' + code);

                this.logger.error({ err, tnx: 'stdin', messageId }, '将消息%s发送到sendmail时出错。%s', messageId, err.message);
                callback(err);
            });

            sendmail.once('close', callback);                   // 处理sendmail进程关闭

            // 处理标准输入错误
            sendmail.stdin.on('error', err => {
                this.logger.error({ err, tnx: 'stdin', messageId }, '将消息%s管道传输到sendmail时发生错误。%s', messageId, err.message);
                callback(err);
            });

            let recipients = formatRecipients(to);              // 处理收件人列表显示
            this.logger.info({ tnx: 'send', messageId }, '正在发送消息%s到<%s>', messageId, recipients.join(', '));

            let sourceStream = mail.message.createReadStream(); // 创建消息读取流
            sourceStream.once('error', err => {
                this.logger.error({ err, tnx: 'stdin', messageId }, '生成消息%s时发生错误。%s', messageId, err.message);
                sendmail.kill('SIGINT');                        // 终止sendmail进程，不投递消息
                callback(err);
            });

            sourceStream.pipe(sendmail.stdin);                  // 将消息流管道传输到sendmail进程
        }
        else return callback(new Error('未找到sendmail'));
    }
}

// 导出
module.exports = SendmailTransport;