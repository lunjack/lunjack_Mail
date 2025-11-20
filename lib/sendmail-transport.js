'use strict';

const { spawn } = require('child_process'); // 引入子进程生成模块
const { PK, getLogger, prepareMessageForSending, cleanup } = require('./shared');

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
        this.options = options, this.name = 'SendmailTransport', this.version = PK.version;
        // 默认sendmail路径,参数数组(默认为false),Windows换行标志(默认为false)
        this.path = 'sendmail', this.args = false, this.winbreak = false;

        const { component = 'sendmail' } = this.options;
        this.logger = getLogger(this.options, { component }); // 获取日志记录器

        // 根据选项配置参数
        if (options) {
            if (typeof options === 'string') this.path = options;  // 如果options是字符串，直接作为sendmail路径
            // 否则,如果options是对象，检查path和args属性
            else if (typeof options === 'object') {
                const { path, args, newline = '' } = options;
                if (path) this.path = path;
                if (Array.isArray(args)) this.args = args;
                // 检查是否使用Windows换行符
                this.winbreak = ['win', 'windows', 'dos', '\r\n'].includes(newline.toString().toLowerCase());
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
        let sendmail;
        const { args, envelope, messageId, readStream }
            = prepareMessageForSending(mail, this.logger, '', { transportType: 'sendmail' }), // 邮件预处理
            state = { returned: false },

            // 资源清理和回调处理 cleanup
            cleanUp = (err, result) => {
                cleanup(state);
                // 确保终止未退出的进程
                if (sendmail && !sendmail.killed && sendmail.exitCode === null) sendmail.kill('SIGINT');
                done?.(err, result);
            },

            // 增强错误处理
            handleError = (err, tnx, context) => {
                this.logger.error({ err, tnx, messageId }, context, messageId, err.message), cleanUp(err);
            };

        try {
            sendmail = this._spawn(this.path, args); // 创建子进程(args:sendmail参数)
        } catch (E) {
            return handleError(E, 'spawn', '生成sendmail进程失败;%s');
        }
        if (!sendmail) return cleanUp(new Error('未找到sendmail或生成进程失败'));

        // 事件处理
        sendmail.stdin.on('error', err => handleError(err, 'stdin', '向sendmail标准输入写入数据失败;%s'));
        sendmail.on('error', err => handleError(err, 'process', 'sendmail进程执行失败;%s'))
            .once('exit', code => {
                if (code === 0) {
                    this.logger.info({ tnx: 'send', messageId }, '消息%s已成功投递', messageId);
                    cleanUp(null, { envelope, messageId, response: '消息已排队等待投递' });
                }
                else {
                    const err = new Error(`${code === 127 ? '未找到Sendmail命令' : 'Sendmail异常退出'} (退出码 ${code})`);
                    handleError(err, 'exit', 'sendmail进程异常退出;%s');
                }
            });

        readStream.once('error', err => handleError(err, 'source', '创建邮件数据流失败;%s'));
        const pipeline = readStream.pipe(sendmail.stdin); // 创建数据管道
        pipeline.on('error', err => handleError(err, 'pipe', '数据管道传输失败;%s'));
    }
}

// 导出
module.exports = SendmailTransport;