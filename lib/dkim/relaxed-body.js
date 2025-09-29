'use strict';

const Transform = require('stream').Transform;
const crypto = require('crypto');

/**
 * 宽松规范化邮件正文的转换流
 * 实现DKIM签名中的relaxed body canonicalization
 * 主要功能：
 * 1. 将所有的行结束符统一为CRLF
 * 2. 移除每行末尾的空白字符(WSP)
 * 3. 将行内的多个空白字符替换为单个空格
 * 4. 计算规范化后内容的哈希值
 */
class RelaxedBody extends Transform {
    /**
     * 构造函数
     * @param {Object} options - 配置选项
     * @param {string} options.hashAlgo - 哈希算法，默认为'sha1'
     * @param {boolean} options.debug - 是否启用调试模式
     */
    constructor(options) {
        super(options);
        options = options || {};

        // 初始化哈希计算器
        this.bodyHash = crypto.createHash(options.hashAlgo || 'sha1');

        // 存储未处理完的数据片段（跨块的未完成行）
        this.remainder = '';

        // 记录已处理的字节长度
        this.byteLength = 0;

        // 调试模式相关设置
        this.debug = options.debug;
        this._debugBody = options.debug ? [] : false;
    }

    /**
     * 处理数据块并更新哈希值
     * 应用宽松规范化规则：
     * 1. 将所有行结束符统一为CRLF
     * 2. 移除行尾空白字符(WSP)
     * 3. 将行内多个空白字符替换为单个空格
     * @param {Buffer} chunk - 输入数据块
     */
    updateHash(chunk) {
        // 将当前数据块转换为字符串并与之前的余数合并
        let chunkStr = chunk.toString('binary');
        let fullStr = this.remainder + chunkStr;

        this.remainder = '';  // 清空余数，将在处理过程中重新收集

        if (fullStr.length === 0) return; // 如果合并后字符串为空，无需处理

        // 使用正则表达式按行分割，保留行结束符信息
        let lines = fullStr.split(/(\r?\n)/);

        // 如果最后一部分不是完整的行结束符，保留作为余数
        if (!/(?:\r\n|\r|\n)$/.test(fullStr)) this.remainder = lines.pop() || '';

        // 处理每一行内容（跳过行结束符部分）
        let processedLines = [];
        for (let i = 0; i < lines.length; i++) {
            // 如果是行结束符，直接添加
            if (i % 2 === 1) {
                processedLines.push(lines[i]);
                continue;
            }

            // 处理行内容
            let line = lines[i];
            line = line.replace(/[ \t]+$/, '');  // 移除行尾空白字符（WSP）
            line = line.replace(/[ \t]+/g, ' '); // 将行内多个空白字符替换为单个空格
            processedLines.push(line);
        }

        // 重新组装处理后的内容
        let processedStr = processedLines.join('');

        // 如果有余数，需要特殊处理（可能是不完整的行）
        if (this.remainder) {
            // 余数中的空白字符处理（但不移除行尾空白，因为可能不是完整行）
            let processedRemainder = this.remainder.replace(/[ \t]+/g, ' ');
            processedStr += processedRemainder;
        }

        // 将处理后的字符串转换回Buffer
        let processedChunk = Buffer.from(processedStr, 'binary');

        // 如果启用调试模,则记录处理后的数据块
        if (this.debug) this._debugBody.push(processedChunk);

        this.bodyHash.update(processedChunk); // 更新哈希值

        this.push(processedChunk); // 将处理后的数据推送到输出流
    }

    /**
     * 转换流的核心方法，处理输入数据
     * @param {Buffer|string} chunk - 输入数据块
     * @param {string} encoding - 编码方式
     * @param {function} callback - 完成回调
     */
    _transform(chunk, encoding, callback) {
        try {
            // 如果是空块，更新哈希并完成
            if (!chunk || !chunk.length) {
                this.updateHash(Buffer.alloc(0));
                return callback();
            }

            // 如果块是字符串，转换为Buffer
            if (typeof chunk === 'string') chunk = Buffer.from(chunk, encoding);

            this.updateHash(chunk); // 处理数据块并更新哈希

            this.byteLength += chunk.length; // 更新已处理的字节长度

            callback();  // 通知转换完成
        } catch (err) {
            callback(err);
        }
    }

    /**
     * 流结束时的处理逻辑
     * 处理剩余数据并发出哈希值
     * @param {function} callback - 完成回调
     */
    _flush(callback) {
        try {
            // 处理剩余的余数
            if (this.remainder) {
                // 对余数应用规范化规则
                let processedRemainder = this.remainder.replace(/[ \t]+$/, '').replace(/[ \t]+/g, ' ');
                let remainderChunk = Buffer.from(processedRemainder, 'binary');

                // 调试模式：记录处理后的余数
                if (this.debug) this._debugBody.push(remainderChunk);

                // 更新哈希值
                this.bodyHash.update(remainderChunk);

                // 将处理后的余数推送到输出流
                this.push(remainderChunk);

                // 更新已处理的字节长度
                this.byteLength += remainderChunk.length;
            }

            // 如果整个消息体为空，添加CRLF
            if (this.byteLength === 0) {
                let crlf = Buffer.from('\r\n');
                this.bodyHash.update(crlf);
                this.push(crlf);
            }
            // 确保以CRLF结束（除非余数已经以CRLF结束）
            else if (!this.remainder.endsWith('\r\n')) {
                let crlf = Buffer.from('\r\n');
                this.bodyHash.update(crlf);
                this.push(crlf);

            }

            // 发出哈希计算完成事件
            this.emit('hash', this.bodyHash.digest('base64'),
                this.debug ? Buffer.concat(this._debugBody) : false);

            callback(); // 通知刷新完成
        } catch (err) {
            callback(err);
        }
    }
}

module.exports = RelaxedBody;