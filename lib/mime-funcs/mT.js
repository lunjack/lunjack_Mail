// MIME类型到文件扩展名的映射表
const MIME_TYPES = new Map([
    ['text/plain', 'txt'],
    ['text/html', 'html'],
    ['text/css', 'css'],
    // 更多MIME类型和扩展名的映射略...
]);

// 文件扩展名到MIME类型的映射表
const EXTENSIONS = new Map([
    ['txt', 'text/plain'],
    ['html', 'text/html'],
    ['css', 'text/css'],
    // 更多扩展名和MIME类型的映射略...
]);

// 导出映射表
module.exports = {
    MIME_TYPES,
    EXTENSIONS
};