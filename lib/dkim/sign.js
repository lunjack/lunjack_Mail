'use strict';

// 引入必要的模块
const { createSign } = require('crypto');       // Node.js加密模块，用于生成签名
const { toASCII } = require('../punycode');     // 用于处理Unicode域名的punycode转换
const { foldLines } = require('../mime-funcs'); // 提供MIME相关工具函数
const { regexs, resetRegex } = require('../regexs');

/**
 * 生成DKIM签名头（不含签名值部分）
 *
 * @param {String} domainName 域名
 * @param {String} keySelector 密钥选择器
 * @param {String} fieldNames 参与签名的头字段列表
 * @param {String} hashAlgo 哈希算法
 * @param {String} bodyHash 正文哈希值
 * @return {String} 生成的DKIM签名头字符串
 */
function _generateDKIMHeader(domainName, keySelector, fieldNames, hashAlgo, bodyHash) {
    // 构建DKIM签名头的各个部分
    let dkim = [
        'v=1',                      // 版本
        `a=rsa-${hashAlgo}`,        // 算法
        'c=relaxed/relaxed',        // 规范化方法（头/正文）
        `d=${toASCII(domainName)}`, // 域名（转换为ASCII）
        'q=dns/txt',                // 查询方式
        `s={keySelector}`,          // 密钥选择器
        `bh=${bodyHash}`,           // 正文哈希
        `h=${fieldNames}`           // 参与签名的头字段
    ].join('; ');                   // 用分号加空格连接

    return `${foldLines(`DKIM-Signature:${dkim}`, 76)};\r\n b=`; // 对长行进行折行处理,并添加头名称和签名开始标记
}

/**
 * 从邮件头中提取并规范化指定字段的数据
 *
 * @param {Array} headers 邮件头数组
 * @param {String} fieldNames 需要处理的字段列表（冒号分隔）
 * @param {String} skipFields 需要跳过的字段列表（冒号分隔）
 * @return {Object} 包含规范化后的头数据和字段列表的对象
 */
function _relaxedHeaders(headers, fieldNames = '', skipFields = '') {
    // 存储最终需要包含的字段,需要跳过的字段,字段名和对应的规范化值
    const includedFields = new Set(), skip = new Set(), headerFields = new Map();

    // 处理需要跳过的字段列表(去除空白并添加到跳过集合)
    skipFields.toLowerCase().split(':').forEach(field => skip.add(field.trim()));

    // 处理需要包含的字段，过滤掉跳过的字段(添加到包含字段集合)
    fieldNames.toLowerCase().split(':').filter(field => !skip.has(field.trim()))
        .forEach(field => includedFields.add(field.trim()));

    // 从后向前遍历头（确保获取每个字段的最后出现值）
    for (let i = headers.length - 1; i >= 0; i--) {
        const { key, line } = headers[i];
        // 只包含第一个遇到的值（从底部到顶部）
        if (includedFields.has(key) && !headerFields.has(key)) headerFields.set(key, _relaxedHeaderLine(line));
    }

    // 构建规范化后的头数据行和字段列表
    const headersList = [], fields = [];
    includedFields.forEach(field => {
        // 如果字段在头中存在，则将其添加到规范化数据中
        if (headerFields.has(field)) fields.push(field), headersList.push(`${field}:${headerFields.get(field)}`);
    });

    // 用CRLF连接所有头行,用冒号连接字段名
    return { headers: `${headersList.join('\r\n')}\r\n`, fieldNames: fields.join(':') };
}

/**
 * 对单行头数据进行"relaxed"规范化
 *
 * @param {String} line 头行字符串
 * @return {String} 规范化后的头值
 */
function _relaxedHeaderLine(line) {
    const rGCOL = resetRegex(regexs.GLOBAL_CRLF_OR_LF), rGW = resetRegex(regexs.GLOBAL_WHITESPACE);
    // 去除字段名部分,移除换行符,将连续空白压缩为单个空格,去除首尾空格
    return line.substring(line.indexOf(':') + 1).replace(rGCOL, '').replace(rGW, ' ').trim();
}

/**
 * 生成DKIM签名头行
 *
 * @param {Object} headers 由MessageParser解析得到的邮件头对象
 * @param {String} bodyHash 邮件正文的Base64编码哈希值
 * @param {Object} options DKIM配置选项
 * @param {String} options.domainName 要进行签名的域名
 * @param {String} options.keySelector 使用的DKIM密钥选择器
 * @param {String} options.privateKey 用于签名的DKIM私钥
 * @return {String} 完整的DKIM签名头行
 */
function generateDKIMSignature(headers, hashAlgo, bodyHash, options = {}) {
    // RFC4871 #5.5中列出的默认签名头字段
    const defaultFieldNames =
        'From:Sender:Reply-To:Subject:Date:Message-ID:To:' +
        'Cc:MIME-Version:Content-Type:Content-Transfer-Encoding:Content-ID:' +
        'Content-Description:Resent-Date:Resent-From:Resent-Sender:' +
        'Resent-To:Resent-Cc:Resent-Message-ID:In-Reply-To:References:' +
        'List-Id:List-Help:List-Unsubscribe:List-Subscribe:List-Post:List-Owner:List-Archive',

        { headerFieldNames, skipFields, domainName, keySelector, privateKey } = options,
        fieldNames = headerFieldNames || defaultFieldNames,            // 使用选项中的头字段列表或默认列表
        result = _relaxedHeaders(headers, fieldNames, skipFields),     // 获取经过"relaxed"规范化的头数据及字段列表

        // 生成DKIM签名头（不包含签名值部分）
        dkimHeader = _generateDKIMHeader(domainName, keySelector, result.fieldNames, hashAlgo, bodyHash);

    let signer, signature;
    result.headers += `dkim-signature:${_relaxedHeaderLine(dkimHeader)}`; // 将DKIM签名头自身添加到规范化数据中（用于生成签名）
    // 创建签名对象，使用指定的哈希算法;更新要签名的数据（规范化后的头数据）
    signer = createSign((`rsa-${hashAlgo}`).toUpperCase()), signer.update(result.headers);
    try {
        signature = signer.sign(privateKey, 'base64');                    // 使用私钥进行签名，输出Base64格式
    } catch (E) {
        return false;
    }

    const rSF = resetRegex(regexs.SIGNATURE_FOLDING);
    return dkimHeader + signature.replace(rSF, '$&\r\n ').trim();         // 返回完整的DKIM签名头，并对长签名进行折行处理
}

// 导出
module.exports = generateDKIMSignature;