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
        mail.message.keepBcc = true;                                       // 保留Bcc字段
        const envelope = mail.data.envelope || mail.message.getEnvelope(); // 获取信封信息
        const messageId = mail.message.messageId();                        // 获取消息ID
        let sendmail, returned = false;
        const { from, to } = envelope;

        // 检查无效地址格式（以连字符开头）
        const hasInvalidAddresses = [...(from || []), ...(to || [])].some(addr => /^-/.test(addr));
        if (hasInvalidAddresses) return done(new Error('无法发送邮件。信封地址无效。'));

        // 构建sendmail参数
        const args = this.args ? ['-i', ...this.args, ...to] : ['-i', ...(from ? ['-f', from] : []), ...to];

        // 资源清理和回调处理
        const cleanUp = (err, result) => {
            if (returned) return;
            returned = true;

            // 确保终止未退出的进程
            if (sendmail && !sendmail.killed && sendmail.exitCode === null) sendmail.kill('SIGINT');
            done?.(err, result);
        };

        // 增强错误处理（包含错误类型）
        const handleError = (err, context, errorType = 'operational') => {
            this.logger.error({ err, tnx: context, messageId, type: errorType }, `处理消息%s时出错(%s): %s`, messageId, context, err.message);
            cleanUp(err);
        };

        try {
            sendmail = this._spawn(this.path, args); // 创建子进程
        } catch (E) {
            return handleError(E, 'spawn', 'process-spawn');
        }
        if (!sendmail) return cleanUp(new Error('未找到sendmail或生成进程失败'));

        // 事件处理
        sendmail.on('error', err => handleError(err, 'process', 'child-process'));
        sendmail.stdin.on('error', err => handleError(err, 'stdin', 'stream'));
        sendmail.once('exit', code => {
            if (code === 0) {
                this.logger.info({ tnx: 'send', messageId }, '消息%s已成功投递', messageId);
                cleanUp(null, { envelope, messageId, response: '消息已排队等待投递' });
            }
            else {
                const err = code === 127 ? new Error(`未找到Sendmail命令 (退出码 ${code})`) : new Error(`Sendmail异常退出 (退出码 ${code})`);
                handleError(err, 'exit', 'process-exit');
            }
        });

        const recipients = formatRecipients(to);              // 收件人格式化处理
        this.logger.info({ tnx: 'send', messageId }, '正在发送消息%s到<%s>', messageId, recipients.join(', '));

        const sourceStream = mail.message.createReadStream(); // 获取源数据流
        sourceStream.once('error', err => handleError(err, 'source-stream', 'read-stream'));

        const pipeline = sourceStream.pipe(sendmail.stdin);  // 创建数据管道
        pipeline.on('error', err => handleError(err, 'pipeline', 'stream-pipe'));
    }
}

// 导出
module.exports = SendmailTransport;