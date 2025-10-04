// 正则表达式常量
const regexs = {

    CRLF: /\r\n/,                                           // 匹配CRLF换行符
    SINGLE_LF: /\n/,                                        // 匹配单个换行符
    LINE_SPLIT: /(\r?\n)/,                                  // 按行分割并保留行结束符
    HEADER_LINE_BREAK: /\r?\n/,                             // 匹配头信息中的换行符
    LEADING_DOT: /^\./,                                     // 匹配开头的点
    FOLDED_HEADER_LINE: /^\s/,                              // 匹配折叠的头信息行（以空白字符开头）
    PROTOCOL_COLON: /:$/,                                   // 匹配协议字符串末尾的冒号
    TRAILING_WSP: /[ \t]+$/,                                // 匹配行尾空白字符（WSP）
    TRAILING_NEWLINE: /\n.*?$/,                             // 匹配行尾的换行符及其后的内容
    LAST_LINE: /(^|\n)([^\n]*)$/,                           // 匹配最后一行（用于换行处理）
    EMAIL_CHECK: /^[^@]+@[^@]+$/,                           // 检查电子邮件格式
    TRAILING_LINE_BREAK: /(?:\r\n|\r|\n)$/,                 // 检测字符串是否以行结束符结尾
    TRAILING_SPACE_OR_PUNCTUATION: /[ \t.,!?][^ \t.,!?]*$/, // 匹配空格、制表符或标点符号以及其后的非空格、非标点符号字符
    UTF8_ENCODING: /^(?:=[\da-f]{2}){1,4}$/i,               // 匹配UTF-8编码序列（1-4个连续的编码字节）
    INCOMPLETE_ENCODING: /[=][\da-f]{0,2}$/i,               // 匹配不完整的编码序列（等号后跟0-2个十六进制数字）
    INCOMPLETE_ENCODING_SHORT: /[=][\da-f]{0,1}$/i,         // 匹配更短的不完整编码序列（等号后跟0-1个十六进制数字）
    PROTOCOL_CHECK: /^(https?|mailto|ftp):/,                // 检查URL协议
    LIST_ID_PROTOCOL_REMOVE: /^<[^:]+\/{,2}/,               // 移除List-ID中的协议部分


    // 需重置的正则表达式
    NON_DIGIT: /\D/g,                                       // 匹配非数字字符
    MULTIPLE_WSP: /[ \t]+/g,                                // 匹配行内多个空白字符
    GLOBAL_CRLF_OR_LF: /\r?\n/g,                            // 全局匹配CRLF或LF换行符
    URL_CLEAN: /[\s<]+|[\s>]+/g,                            // 清理URL中的空白和尖括号
    GLOBAL_MULTIPLE_WHITESPACE: /\s+/g,                     // 全局匹配多个连续空白字符
    SIGNATURE_FOLDING: /(^.{73}|.{75}(?!\r?\n|\r))/g,       // 签名折行处理正则
    COMPLETE_ENCODING: /[=][\da-f]{2}$/gi,                  // 匹配完整的编码序列（等号后跟2个十六进制数字）
    DATA_URL_IMAGE: /(]{0,1024} src\s{0,20}=[\s"']{0,20})(data:([^;]+);[^"'>\s]+)/gi, // 匹配HTML中的data URL图片
};

/**
 * 重置正则表达式的lastIndex属性
 * @param {RegExp} regex - 需要重置的正则表达式
 * @returns {RegExp} 重置后的正则表达式
 */
function resetRegex(regex) {
    regex.lastIndex = 0;
    return regex;
}

// 统一导出
module.exports = {
    regexs,
    resetRegex
};