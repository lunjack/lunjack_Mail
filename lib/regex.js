// 正则表达式常量
const regex = {
    CRLF: /\r\n/,                                           // 匹配CRLF换行符
    SINGLE_LF: /\n/,                                        // 匹配单个换行符
    TRAILING_NEWLINE: /\n.*?$/,                             // 匹配行尾的换行符及其后的内容
    TRAILING_SPACE_OR_PUNCTUATION: /[ \t.,!?][^ \t.,!?]*$/, // 匹配空格、制表符或标点符号以及其后的非空格、非标点符号字符
    INCOMPLETE_ENCODING: /[=][\da-f]{0,2}$/i,               // 匹配不完整的编码序列（等号后跟0-2个十六进制数字）
    INCOMPLETE_ENCODING_SHORT: /[=][\da-f]{0,1}$/i,         // 匹配更短的不完整编码序列（等号后跟0-1个十六进制数字）
    UTF8_ENCODING: /^(?:=[\da-f]{2}){1,4}$/i,               // 匹配UTF-8编码序列（1-4个连续的编码字节）
    LAST_LINE: /(^|\n)([^\n]*)$/,                           // 匹配最后一行（用于换行处理）

    // 需重置的正则表达式
    COMPLETE_ENCODING: /[=][\da-f]{2}$/gi,                  // 匹配完整的编码序列（等号后跟2个十六进制数字）
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
    regex,
    resetRegex
};