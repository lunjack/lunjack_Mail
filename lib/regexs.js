// 正则表达式常量
const regexs = {
    LINE_SEPARATOR: /\r?\n/,                                // 按行分割丢弃换行符
    SPLIT_KEEP_NEWLINE: /(\r?\n)/,                          // 按行分割并保留行结束符
    LINE_BREAK: /^[^\n\r]*(\r?\n|\r)/,                      // 匹配行结束符
    INVALID_ADDRESS_CHARS: /[\r\n<>]/,                      // 匹配地址中的非法字符（回车、换行、<>）
    WHITESPACE: /\s+/,                                      // 匹配空白字符
    FOLDED_HEADER_LINE: /^\s/,                              // 匹配折叠的头信息行（以空白字符开头）
    RESPONSE_CODE: /^(\d+)(?:\s(\d+\.\d+\.\d+))?\s/,        // 匹配SMTP响应代码和可选状态码
    NEXT_WORD: /^[^\s]+(\s*)/,                              // 匹配下一个单词及其后的空白
    ADDRESS_CLEAN: /^[^<]*<\s*/,                            // 地址令牌清理：清理地址令牌中的多余字符
    EMAIL_LOOSE: /\s*\b[^@\s]+@[^\s]+\b\s*/,                // 邮箱地址宽松匹配：匹配文本中可能包含特殊字符的邮箱地址
    UNSAFE_PARAM_VALUE: /[\s'"\\;:/=(),<>@[\]?]|^-/,        // 匹配参数值中的不安全字符或以连字符开头

    TRAILING_WSP: /[ \t]+$/,                                // 匹配行尾空白字符（WSP）
    OPTIONAL_CRLF: /\r?\n$/,                                // 匹配可选的CRLF行结束符
    TRAILING_NEWLINE: /\n.*?$/,                             // 匹配行尾的换行符及其后的内容
    LAST_LINE: /(^|\n)([^\n]*)$/,                           // 匹配最后一行（用于换行处理）
    EMAIL_CHECK: /^[^@]+@[^@]+$/,                           // 检查电子邮件格式
    TRAILING_SPACES: /(\s+)[^\s]*$/,                        // 匹配行尾的空白字符及其后的非空白字符
    EMAIL_EXACT: /^[^@\s]+@[^@\s]+$/,                       // 邮箱地址精确匹配：匹配简单的邮箱格式（名称@域名）
    PRINTABLE_ASCII: /^[\x20-\x7e]*$/,                      // 匹配可打印ASCII字符
    CRAM_MD5_CHALLENGE: /^334\s+(.+)$/,                     // 匹配CRAM-MD5挑战字符串
    TRAILING_LINE_BREAK: /(?:\r\n|\r|\n)$/,                 // 检测字符串是否以行结束符结尾
    RFC2231_KEY: /(\*(\d+)|\*(\d+)\*|\*)$/,                 // 匹配RFC2231格式的参数键名（带星号和编号）
    RALPHANUMERIC_UNDERSCORE_SPACE: /^[\w ]*$/,             // 匹配仅包含字母数字、下划线和空格的字符串
    CHARSET_LANGUAGE_VALUE: /^([^']*)'[^']*'(.*)$/,         // 匹配字符集、语言和值的格式（RFC2231）
    IPV4_ADDRESS: /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/,   // 匹配IPv4地址格式
    UNSAFE_HEADER_PARAM: /[\s"\\;:/=(),<>@[\]?]|^[-']|'$/,  // 匹配头参数值中的不安全字符
    TRAILING_SPACE_OR_PUNCTUATION: /[ \t.,!?][^ \t.,!?]*$/, // 匹配空格、制表符或标点符号以及其后的非空格、非标点符号字符
    LAST_NON_ASCII_WORD: /([^\x00-\x7F][^\s]*)[^"\x00-\x7F]*$/,// 匹配最后一个包含非ASCII字符的单词

    AUTH: /[ -]AUTH\b/i,                                    // 匹配AUTH支持
    DATA_URL: /^data:/i,                                    // 检测Data URL格式
    TEXT_TYPE: /^text\//i,                                  // 匹配所有text/*内容类型
    IMAGE_TYPE: /^image\//i,                                // 检测图像内容类型
    HTTP_URL: /^https?:\/\//i,                              // 检测HTTP/HTTPS协议
    ERROR_SUFFIX: /Error\]$/i,                              // 匹配以"Error]"结尾的字符串（不区分大小写）
    MULTIPART: /^multipart\//i,                             // 匹配multipart/*内容类型
    HTML_TYPE: /^text\/html\b/i,                            // 检测HTML内容类型
    MESSAGE_TYPE: /^message\//i,                            // 检测消息内容类型
    ENCODED_SEQUENCE: /^[=]([0-9A-F]{2})/i,                 // 匹配编码序列（等号后跟2个十六进制数字）
    CONTENT_FEATURES: /^Content-Features$/i,                // 匹配Content-Features头部
    UTF8_ENCODING: /^(?:=[\da-f]{2}){1,4}$/i,               // 匹配UTF-8编码序列（1-4个连续的编码字节）
    INCOMPLETE_ENCODING: /[=][\da-f]{0,2}$/i,               // 匹配不完整的编码序列（等号后跟0-2个十六进制数字）
    INCOMPLETE_ENCODING_END: /[=][0-9A-F]?$/i,              // 匹配字符串末尾的不完整编码序列
    TRANSPORTER_PROTOCOL: /^(smtps?|direct):/i,             // 匹配传输器协议（smtp://, smtps://, direct://）
    INCOMPLETE_ENCODING_SHORT: /[=][\da-f]{0,1}$/i,         // 匹配更短的不完整编码序列（等号后跟0-1个十六进制数字）
    MULTIPART_OR_MESSAGE: /^(multipart|message)\//i,        // 匹配multipart/*或message/*内容类型
    HTTP_RESPONSE_STATUS_LINE: /^HTTP\/\d+\.\d+ (\d+)/i,    // 匹配 HTTP 响应状态行
    AUTH_MECHANISM: /[ -]AUTH(?:(\s+|=)[^\n]*\s+|\s+|=)/i,  // 匹配AUTH机制
    IPV6_ADDRESS: /^(?:[A-F0-9]{1,4}:){7}[A-F0-9]{1,4}$/i,  // 匹配IPv6地址格式

    NON_ASCII: /\P{ASCII}/u,                                // 匹配非ASCII字符（Unicode字符）
    NON_BASIC_ASCII: /[^\x00-\x7F]/,                        // 检测非基本ASCII字符（编码>127）
    PROTOCOL_CHECK: /^(https?|mailto|ftp):/,                // 检查URL协议
    LIST_ID_PROTOCOL_REMOVE: /^<[^:]+\/{,2}/,               // 移除List-ID中的协议部分
    UTF16_HIGH_SURROGATE: /[\uD800-\uDBFF]/,                // 匹配UTF-16高代理项（代理对的第一部分）
    EMOJI_OR_SURROGATE: /[\ud83c\ud83d\ud83e]/,             // 匹配emoji或UTF-16代理对起始字符
    PLAIN_TEXT: /[^\x09\x0a\x0d\x20-\x7e]/,                 // 匹配非可打印7位ASCII字符（允许\t\n\r和\x20-\x7e）
    PARAM_PLAIN_TEXT: /[^\x09\x0a\x0d\x20-\x7e]|"/,         // 匹配非可打印字符或双引号（参数校验用）
    FIRST_NON_ASCII_WORD: /(?:^|\s)([^\s]*[^\x00-\x7F])/,   // 匹配第一个包含非ASCII字符的单词
    NEED_ENCODING: /[\x00-\x20\x2B\x3D\x7F]|[^\x21-\x7E]/,  // 不可打印ASCII字符（包括非ASCII字符）

    DSN: /[ -]DSN\b/im,                                      // 匹配DSN扩展支持
    STARTTLS: /[ -]STARTTLS\b/im,                            // 匹配STARTTLS扩展支持
    SMTPUTF8: /[ -]SMTPUTF8\b/im,                            // 匹配SMTPUTF8扩展支持
    _8BITMIME: /[ -]8BITMIME\b/im,                           // 匹配8BITMIME扩展支持
    PIPELINING: /[ -]PIPELINING\b/im,                        // 匹配PIPELINING扩展支持
    SIZE: /[ -]SIZE(?:[ \t]+(\d+))?/im,                      // 匹配SIZE扩展和大小值

    DATA_RESPONSE: /^[23]/,                                  // 匹配DATA命令的2xx或3xx响应码
    AUTH_SUCCESS: /^235\s+/,                                 // 匹配认证成功的235响应码
    AUTH_RESPONSE: /^334[ -]/,                               // 匹配AUTH认证的334响应码
    CONTINUATION_RESPONSE: /^\d+-/,                          // 匹配以数字开头后跟连字符
    DIGIT_HYPHEN_PREFIX: /^\d+[ -]/,                         // 匹配数字开头后跟空格或连字符
    RESPONSE_4XX_5XX: /^[45]\d{2}\b/,                        // 匹配4xx或5xx错误响应码
    TEXT_PLAIN: /^text\/plain\b/,                            // 匹配text/plain内容类型

    // 需重置的正则表达式
    NON_DIGIT: /\D/g,                                       // 匹配非数字字符
    CID_CLEAN: /[<>]/g,                                     // 清理Content-ID中的尖括号
    BLANK_REGEX: /\s/g,                                     // 匹配所有空白字符
    URL_SAFE_BASE64: /\W/g,                                 // 匹配非单词字符（非字母、数字、下划线）
    MULTIPLE_WSP: /[ \t]+/g,                                // 匹配行内多个空白字符
    LINEBREAKS: /\r?\n|\r/g,                                // 匹配各种换行符（CRLF、LF、CR）
    QUOTED_PAIR: /([\\"])/g,                                // 匹配需要转义的字符（反斜杠和引号）
    HYPHEN_REPLACE: /-(\w)/g,                               // 连字符替换为驼峰命名
    ANGLE_BRACKET: /<[^>]*>/g,                              // 匹配尖括号内的内容
    GLOBAL_WHITESPACE: /\s+/g,                              // 匹配多个连续空白字符为单个空格
    ENCODING_FORMAT: /[-_\s]/g,                             // 格式化编码字符串
    CLEAN_MESSAGE_ID: /[<>\s]/g,                            // 清理message-id头，移除尖括号和空白字符
    GLOBAL_CRLF_OR_LF: /\r?\n/g,                            // 匹配CRLF或LF换行符
    URL_CLEAN: /[\s<]+|[\s>]+/g,                            // 清理URL中的空白和尖括号
    RFC2231_SPECIAL_CHARS: /[=?_\s]/g,                      // RFC2231编码中需要转义的特殊字符：等号、问号、下划线和空白字符
    FORBIDDEN_CHARS: /[\x00-\x1F<>]+/g,                     // 匹配控制字符和尖括号（不允许的字符）
    SEPARATORS: /[\x2E\u3002\uFF0E\uFF61]/g,                // RFC 3490 分隔符
    NON_ALPHANUMERIC_DOT_HYPHEN: /[^a-zA-Z0-9.-]/g,         // 匹配非字母数字、点号和连字符的字符
    SIGNATURE_FOLDING: /(^.{73}|.{75}(?!\r?\n|\r))/g,       // 签名折行处理正则
    NON_LATIN: /[\x00-\x08\x0B\x0C\x0E-\x1F\P{ASCII}]/gu,   // 匹配非拉丁字符（控制字符和Unicode）
    NON_SAFE_URI: /[^\x00-\x1F *'()<>@,;:\\"[\]?=\u007F-\uFFFF]+/g,    // 匹配URI中的不安全字符范围
    NON_SAFE_URI_CHAR: /[\x00-\x1F *'()<>@,;:\\"[\]?=\u007F-\uFFFF]/g, // 匹配单个URI不安全字符
    LATIN: /[a-z]/gi,                                       // 匹配拉丁字母
    NON_SAFE_CHAR: /[^a-z0-9!*+\-/=]/gi,                    // 匹配非安全字符（用于QP编码）
    COMPLETE_ENCODING: /[=][\da-f]{2}$/gi,                  // 匹配完整的编码序列（等号后跟2个十六进制数字）
    DATA_URL_IMAGE: /(]{0,1024} src\s{0,20}=[\s"']{0,20})(data:([^;]+);[^"'>\s]+)/gi, // 匹配HTML中的data URL图片
    NORMALIZE_HEADER_KEY: /^X-SMTPAPI$|^(MIME|DKIM|ARC|BIMI)\b|^[a-z]|-(SPF|FBL|ID|MD5)$|-[a-z]/gi, // 头部键规范化规则
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
module.exports = { regexs, resetRegex };