'use strict';

const { Transform } = require('stream');
const { createHash } = require('crypto');
const { regexs, resetRegex } = require('../regexs');

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
    constructor(options = {}) {
        super(options);
        const { hashAlgo, debug } = options;
        // 初始化哈希计算器,存储未处理完的数据片段(跨块的未完成行),记录已处理的字节长度
        this.bodyHash = createHash(hashAlgo || 'sha1'), this.remainder = '', this.byteLength = 0;
        this.debug = debug, this._debugBody = debug ? [] : false; // 调试模式相关设置
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
        const fullStr = this.remainder + chunk.toString('binary');
        if (fullStr.length === 0) return;                       // 如果合并后字符串为空，无需处理
        this.remainder = '';                                    // 清空余数，将在处理过程中重新收集
        const lines = fullStr.split(regexs.SPLIT_KEEP_NEWLINE); // 使用正则表达式按行分割，保留行结束符信息
        if (!regexs.TRAILING_LINE_BREAK.test(fullStr)) this.remainder = lines.pop() || ''; // 如最后不是完整的行结束符,保留作为余数

        // 处理每一行内容（跳过行结束符部分）
        const processedLines = [];
        for (let i = 0; i < lines.length; i++) {
            // 如果是行结束符，直接添加
            if (i % 2 === 1) {
                processedLines.push(lines[i]);
                continue;
            }

            // 处理行内容
            let line = lines[i];
            line = line.replace(regexs.TRAILING_WSP, '');               // 移除行尾空白字符（WSP）
            const M_WPS = resetRegex(regexs.MULTIPLE_WSP);
            line = line.replace(M_WPS, ' '), processedLines.push(line); // 将行内多个空白字符替换为单个空格并添加到结果中

        }

        // 重新组装处理后的内容
        let processedStr = processedLines.join('');
        // 如果有余数，需要特殊处理（可能是不完整的行）
        if (this.remainder) {
            // 余数中的空白字符处理（但不移除行尾空白，因为可能不是完整行）
            const rMW = resetRegex(regexs.MULTIPLE_WSP), pRemainder = this.remainder.replace(rMW, ' ');
            processedStr += pRemainder;
        }

        const processedChunk = Buffer.from(processedStr, 'binary');      // 将处理后的字符串转换回Buffer
        if (this.debug) this._debugBody.push(processedChunk);            // 如果启用调试模,则记录处理后的数据块
        this.bodyHash.update(processedChunk), this.push(processedChunk); // 更新哈希值并将处理后的数据推送到输出流

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
            if (!chunk?.length) {
                this.updateHash(Buffer.alloc(0));
                return callback();
            }
            if (typeof chunk === 'string') chunk = Buffer.from(chunk, encoding); // 如果块是字符串,转换为Buffer

            // 处理数据块并更新哈希,更新已处理的字节长度,最后通知转换完成
            this.updateHash(chunk); this.byteLength += chunk.length; callback();
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
                const rMW = resetRegex(regexs.MULTIPLE_WSP),
                    pRemainder = this.remainder.replace(regexs.TRAILING_WSP, '').replace(rMW, ' '),
                    remainderChunk = Buffer.from(pRemainder, 'binary');

                if (this.debug) this._debugBody.push(remainderChunk); // 调试模式：记录处理后的余数
                // 更新哈希值,将处理后的余数推送到输出流,然后更新已处理的字节长
                this.bodyHash.update(remainderChunk); this.push(remainderChunk); this.byteLength += remainderChunk.length;
            }

            // 确保以CRLF结束（如果消息体为空，或者余数不以CRLF结束）
            if (this.byteLength === 0 || !this.remainder.endsWith('\r\n')) {
                const crlf = Buffer.from('\r\n');
                this.bodyHash.update(crlf), this.push(crlf);
            }

            // 发出哈希计算完成事件
            this.emit('hash', this.bodyHash.digest('base64'), this.debug ? Buffer.concat(this._debugBody) : false);
            callback(); // 通知刷新完成
        } catch (err) {
            callback(err);
        }
    }
}

module.exports = RelaxedBody;