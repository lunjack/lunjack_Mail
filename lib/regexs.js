// 正则表达式常量
const regexs = {
    CRLF: /\r\n/,                                           // 匹配CRLF换行符
    SINGLE_LF: /\n/,                                        // 匹配单个换行符
    LINE_SPLIT: /(\r?\n)/,                                  // 按行分割并保留行结束符
    HEADER_LINE_BREAK: /\r?\n/,                             // 匹配头信息中的换行符
    LINE_BREAK: /^[^\n\r]*(\r?\n|\r)/,                      // 匹配行结束符
    LEADING_DOT: /^\./,                                     // 匹配开头的点
    NEXT_WORD: /^[^\s]+(\s*)/,                              // 匹配下一个单词及其后的空白
    FOLDED_HEADER_LINE: /^\s/,                              // 匹配折叠的头信息行（以空白字符开头）
    NON_WHITESPACE: /[^\s]/,                                // 匹配非空白字符
    WHITESPACE: /\s+/,                                // 匹配空白字符
    UNSAFE_PARAM_VALUE: /[\s'"\\;:/=(),<>@[\]?]|^-/,        // 匹配参数值中的不安全字符或以连字符开头

    PROTOCOL_COLON: /:$/,                                   // 匹配协议字符串末尾的冒号
    TRAILING_WSP: /[ \t]+$/,                                // 匹配行尾空白字符（WSP）
    TRAILING_NEWLINE: /\n.*?$/,                             // 匹配行尾的换行符及其后的内容
    LAST_LINE: /(^|\n)([^\n]*)$/,                           // 匹配最后一行（用于换行处理）
    EMAIL_CHECK: /^[^@]+@[^@]+$/,                           // 检查电子邮件格式
    TRAILING_SPACES: /(\s+)[^\s]*$/,                        // 匹配行尾的空白字符及其后的非空白字符
    TRAILING_LINE_BREAK: /(?:\r\n|\r|\n)$/,                 // 检测字符串是否以行结束符结尾
    RFC2231_KEY: /(\*(\d+)|\*(\d+)\*|\*)$/,                 // 匹配RFC2231格式的参数键名（带星号和编号）
    PRINTABLE_ASCII: /^[\x20-\x7e]*$/,                // 匹配可打印ASCII字符
    CHARSET_LANGUAGE_VALUE: /^([^']*)'[^']*'(.*)$/,         // 匹配字符集、语言和值的格式（RFC2231）
    RALPHANUMERIC_UNDERSCORE_SPACE: /^[\w ]*$/,        // 匹配仅包含字母数字、下划线和空格的字符串
    UNSAFE_HEADER_PARAM: /[\s"\\;:/=(),<>@[\]?]|^[-']|'$/,  // 匹配头参数值中的不安全字符
    TRAILING_SPACE_OR_PUNCTUATION: /[ \t.,!?][^ \t.,!?]*$/, // 匹配空格、制表符或标点符号以及其后的非空格、非标点符号字符
    LAST_NON_ASCII_WORD: /(["\u0080-\uFFFF][^\s]*)[^"\u0080-\uFFFF]*$/, // 匹配最后一个包含非ASCII字符的单词

    TEXT_TYPE: /^text\//i,                            // 匹配所有text/*内容类型
    MULTIPART: /^multipart\//i,                       // 匹配multipart/*内容类型
    ENCODED_SEQUENCE: /^[=]([0-9A-F]{2})/i,                 // 匹配编码序列（等号后跟2个十六进制数字）
    UTF8_ENCODING: /^(?:=[\da-f]{2}){1,4}$/i,               // 匹配UTF-8编码序列（1-4个连续的编码字节）
    INCOMPLETE_ENCODING: /[=][\da-f]{0,2}$/i,               // 匹配不完整的编码序列（等号后跟0-2个十六进制数字）
    INCOMPLETE_ENCODING_END: /[=][0-9A-F]?$/i,              // 匹配字符串末尾的不完整编码序列
    CONTENT_FEATURES: /^Content-Features$/i,          // 匹配Content-Features头部
    INCOMPLETE_ENCODING_SHORT: /[=][\da-f]{0,1}$/i,         // 匹配更短的不完整编码序列（等号后跟0-1个十六进制数字）
    MULTIPART_OR_MESSAGE: /^(multipart|message)\//i,  // 匹配multipart/*或message/*内容类型

    PROTOCOL_CHECK: /^(https?|mailto|ftp):/,                // 检查URL协议
    LIST_ID_PROTOCOL_REMOVE: /^<[^:]+\/{,2}/,               // 移除List-ID中的协议部分
    NON_ASCII: /[\u0080-\uFFFF]/,                     // 匹配非ASCII字符（Unicode字符）
    UTF16_HIGH_SURROGATE: /[\uD800-\uDBFF]/,                // 匹配UTF-16高代理项（代理对的第一部分）
    NON_PRINTABLE: /[^\x09\x0a\x0d\x20-\x7e]/,              // 匹配非可打印ASCII字符
    EMOJI_OR_SURROGATE: /[\ud83c\ud83d\ud83e]/,             // 匹配emoji或UTF-16代理对起始字符
    FIRST_NON_ASCII_WORD: /(?:^|\s)([^\s]*["\u0080-\uFFFF])/,     // 匹配第一个包含非ASCII字符的单词
    NON_PRINTABLE_AND_DOUBLE_QUOTE: /[^\x09\x0a\x0d\x20-\x7e]|"/, // 匹配非可打印ASCII字符或双引号（用于参数检查）
    TEXT_PLAIN: /^text\/plain\b/, // 匹配text/plain内容类型

    // HEADER_LINE_BREAK:/\r?\n/,

    // 需重置的正则表达式
    NON_DIGIT: /\D/g,                                       // 匹配非数字字符
    MULTIPLE_WSP: /[ \t]+/g,                                // 匹配行内多个空白字符
    REGEX_CRLF: /\r?\n|\r/g,                                // 匹配各种换行符（CRLF、LF、CR）
    GLOBAL_CRLF_OR_LF: /\r?\n/g,                            // 全局匹配CRLF或LF换行符
    URL_CLEAN: /[\s<]+|[\s>]+/g,                            // 清理URL中的空白和尖括号
    QUOTED_PAIR: /([\\"])/g,                          // 匹配需要转义的字符（反斜杠和引号）
    REGEX_ANGLE_BRACKET: /<[^>]*>/g,                        // 匹配尖括号内的内容
    RFC2231_SPECIAL_CHARS: /[=?_\s]/g,                      // RFC2231编码中需要转义的特殊字符：等号、问号、下划线和空白字符
    GLOBAL_MULTIPLE_WHITESPACE: /\s+/g,                     // 全局匹配多个连续空白字符
    REGEX_FORBIDDEN_CHARS: /[\x00-\x1F<>]+/g,               // 匹配控制字符和尖括号（不允许的字符）
    SIGNATURE_FOLDING: /(^.{73}|.{75}(?!\r?\n|\r))/g,       // 签名折行处理正则
    REGEX_NON_LATIN: /[\x00-\x08\x0B\x0C\x0E-\x1F\u0080-\uFFFF]/g,     // 匹配非拉丁字符（控制字符和Unicode）
    NON_SAFE_URI: /[^\x00-\x1F *'()<>@,;:\\"[\]?=\u007F-\uFFFF]+/g,    // 匹配URI中的不安全字符范围
    NON_SAFE_URI_CHAR: /[\x00-\x1F *'()<>@,;:\\"[\]?=\u007F-\uFFFF]/g, // 匹配单个URI不安全字符
    REGEX_LATIN: /[a-z]/gi,                                 // 匹配拉丁字母
    NON_SAFE_CHAR: /[^a-z0-9!*+\-/=]/gi,                    // 匹配非安全字符（用于QP编码）
    COMPLETE_ENCODING: /[=][\da-f]{2}$/gi,                  // 匹配完整的编码序列（等号后跟2个十六进制数字）
    DATA_URL_IMAGE: /(]{0,1024} src\s{0,20}=[\s"']{0,20})(data:([^;]+);[^"'>\s]+)/gi, // 匹配HTML中的data URL图片
    REGEX_NORMALIZE_HEADER_KEY: /^X-SMTPAPI$|^(MIME|DKIM|ARC|BIMI)\b|^[a-z]|-(SPF|FBL|ID|MD5)$|-[a-z]/gi, // 头部键规范化规则
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