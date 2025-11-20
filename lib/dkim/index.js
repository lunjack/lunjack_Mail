'use strict';

/**
 * 用于邮件服务器或邮件发送系统，为外发邮件添加DKIM签名，
 * 提高邮件的可信度和防伪造能力，帮助通过SPF、DKIM、DMARC等反垃圾邮件验证
 */
const fs = require('fs');
const path = require('path');
const { PassThrough } = require('stream');
const { randomBytes } = require('crypto');
const MessageParser = require('./message-parser'); // 用于解析邮件头和正文
const RelaxedBody = require('./relaxed-body');     // 用于宽松规范化邮件正文
const signer = require('./sign');                  // 用于生成DKIM签名字段

const DKIM_ALGO = 'sha256';                // DKIM签名的默认哈希算法
const MAX_MESSAGE_SIZE = 2 * 1024 * 1024; // 将大于此大小的消息缓冲到磁盘

// 用法示例：
/*
// 1. 创建DKIM实例
let dkim = new DKIM({
    domainName: 'example.com',        // 域名，用于标识签名来源
    keySelector: 'key-selector',      // 密钥选择器，用于在DNS中查找公钥
    privateKey,                       // RSA私钥，用于生成数字签名
    cacheDir: '/tmp'                  // 缓存目录，用于处理大邮件时的临时存储
});

// 2. 对邮件进行签名
    dkim.sign(input).pipe(process.stdout);

* 参数说明：
*   input: 输入邮件内容，可以是以下类型：
*   Stream (流)：可读流，包含RFC822格式的原始邮件
*   String (字符串)：邮件内容的字符串形式
*   Buffer (缓冲区)：邮件内容的二进制缓冲区
*
* - 返回值：一个可读流，包含已添加DKIM签名的完整邮件
*
* 工作流程：
* 1. 解析输入邮件的头部和正文
* 2. 对邮件正文进行规范化处理并计算哈希值
* 3. 使用私钥对指定邮件头字段和正文哈希进行签名
* 4. 在邮件头部添加DKIM-Signature字段
* 5. 输出完整的已签名邮件
*/

// DKIM 签名器类
class DKIMSigner {
    // 初始化 DKIM 签名器实例
    constructor(options = {}, keys, input, output) {
        this.options = options;
        const { cacheTreshold, hashAlgo, cacheDir } = this.options;
        this.cacheTreshold = Number(cacheTreshold) || MAX_MESSAGE_SIZE;
        this.hashAlgo = hashAlgo || DKIM_ALGO, this.cacheDir = cacheDir || false;
        this.keys = keys, this.chunks = [], this.chunklen = 0, this.readPos = 0;
        this.cachePath =
            this.cacheDir ? path.join(this.cacheDir, `message.${Date.now()}-${randomBytes(14).toString('hex')}`) : false;

        this.input = input, this.output = output;
        this.cache = false, this.headers = false, this.bodyHash = false, this.parser = false, this.relaxedBody = false;
        this.output.usingCache = false, this.hasErrored = false;
        this.input.on('error', err => {
            this.hasErrored = true, this.cleanup(), output.emit('error', err);
        });
    }

    // 清理缓存文件
    cleanup() {
        if (!this.cache || !this.cachePath) return; // 如果没有缓存文件则不需要清理
        fs.unlink(this.cachePath, () => false);     // 删除缓存文件(忽略错误)
    }

    // 创建读取缓存流
    createReadCache() {
        // 将剩余数据管道传输到缓存文件
        this.cache = fs.createReadStream(this.cachePath);
        this.cache.once('error', err => {
            this.cleanup(), this.output.emit('error', err);
        }).once('close', () => this.cleanup());
        this.cache.pipe(this.output);
    }

    // 发送下一个数据块
    sendNextChunk() {
        if (this.hasErrored) return; // 如果已经出错则不继续发送数据

        // 如果没有缓存文件则结束输出,否则创建读取缓存流
        if (this.readPos >= this.chunks.length) return !this.cache ? this.output.end() : this.createReadCache();
        // 写入数据，如果返回false则等待'drain'事件
        const chunk = this.chunks[this.readPos++];
        if (this.output.write(chunk) === false) return this.output.once('drain', () => this.sendNextChunk());
        setImmediate(() => this.sendNextChunk());
    }

    // 发送签名后的输出
    sendSignedOutput() {
        let keyPos = 0;
        const signNextKey = () => {
            // 所有密钥都已处理，发送原始头部并继续发送数据块
            if (keyPos >= this.keys.length) {
                this.output.write(this.parser.rawHeaders);
                return setImmediate(() => this.sendNextChunk());
            }
            const { domainName, keySelector, privateKey } = this.keys[keyPos++], { headerFieldNames, skipFields } = this.options,
                // 定义 DKIM 签名字段
                dkimField = signer(this.headers, this.hashAlgo, this.bodyHash,
                    { domainName, keySelector, privateKey, headerFieldNames, skipFields });
            if (dkimField) this.output.write(Buffer.from(`${dkimField}\r\n`)); // 如果签名成功则写入 DKIM 字段
            return setImmediate(signNextKey);
        };

        if (this.bodyHash && this.headers) return signNextKey();               // 如果已经有bodyHash和headers则直接签名
        this.output.write(this.parser.rawHeaders), this.sendNextChunk();
    }

    // 创建写入缓存流
    createWriteCache() {
        this.output.usingCache = true, this.cache = fs.createWriteStream(this.cachePath);  // 将剩余数据管道传输到缓存文件
        // 处理缓存流的错误和关闭事件
        this.cache.once('error', err => {
            this.cleanup(), this.relaxedBody.unpipe(this.cache);    // 清理缓存文件,停止传输到缓存
            this.relaxedBody.resume();                              // 自动消耗剩余数据
            this.hasErrored = true, this.output.emit('error', err); // 触发错误事件
        }).once('close', () => this.sendSignedOutput());
        this.relaxedBody.removeAllListeners('readable'), this.relaxedBody.pipe(this.cache);
    }

    // 开始签名流处理
    signStream() {
        this.parser = new MessageParser();
        this.relaxedBody = new RelaxedBody({ hashAlgo: this.hashAlgo }); // 使用宽松的正文处理
        this.parser.on('headers', value => this.headers = value);        // 监听解析器的头部事件
        this.relaxedBody.on('hash', value => this.bodyHash = value);     // 监听宽松正文的哈希事件

        // 监听宽松正文的可读事件
        this.relaxedBody.on('readable', () => {
            let chunk;
            if (this.cache) return; // 如果已经是缓存模式则不继续处理
            while ((chunk = this.relaxedBody.read()) !== null) {
                this.chunks.push(chunk), this.chunklen += chunk.length;
                // 如果数据块长度超过阈值且有缓存路径则切换到缓存模式
                if (this.chunklen >= this.cacheTreshold && this.cachePath) return this.createWriteCache();
            }
        });

        // 监听宽松正文的结束事件
        this.relaxedBody.on('end', () => {
            if (this.cache) return; // 如果已经是缓存模式则不继续处理
            this.sendSignedOutput();
        });

        this.parser.pipe(this.relaxedBody), setImmediate(() => this.input.pipe(this.parser));
    }
}

// DKIM 主类
class DKIM {
    // 初始化 DKIM 实例
    constructor(options = {}) {
        this.options = options;
        const { keys, domainName, keySelector, privateKey } = this.options;
        this.keys = [].concat(keys || { domainName, keySelector, privateKey });
    }

    // 签名输入数据
    sign(input, extraOptions = {}) {
        const output = new PassThrough();
        let inputStream = input, writeValue = false;

        // 如果输入是字符串或Buffer，则转换为流
        if (Buffer.isBuffer(input)) writeValue = input, inputStream = new PassThrough();
        // 否则如果输入是字符串，则转换为Buffer
        else if (typeof input === 'string') writeValue = Buffer.from(input), inputStream = new PassThrough();

        const options = this.options;
        let newOptions = {};
        // 如果有额外选项，则合并选项
        if (extraOptions && Object.keys(extraOptions).length) {
            newOptions = { ...options };
            // 仅添加不存在的选项
            Object.keys(extraOptions).forEach(key => {
                if (!(key in newOptions)) newOptions[key] = extraOptions[key]
            });
        }
        else newOptions = options;

        const signer = new DKIMSigner(newOptions, this.keys, inputStream, output); // 创建 DKIM 签名器实例，使用最终的合并选项
        // 异步启动签名流处理
        setImmediate(() => {
            signer.signStream();
            if (writeValue) setImmediate(() => inputStream.end(writeValue));       // 如果有写入值，则在下一个事件循环中结束输入流
        });

        return output;
    }
}

module.exports = DKIM;