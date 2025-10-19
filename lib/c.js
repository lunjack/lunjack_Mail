/**
 * 解析字符串或Buffer值的内容值
 * @param {object} data - 包含内容的对象或数组
 * @param {string|number} key - 属性名或数组索引
 * @param {function} callback - 回调函数
 * @returns {Promise|undefined} 可能返回Promise
 */
function resolveContent(data, key, callback) {
    // 如果没有提供回调，创建Promise
    let promise;
    if (!callback) {
        promise = new Promise((resolve, reject) => {
            callback = callbackPromise(resolve, reject);
        });
    }

    const content = data?.[key]?.content ?? data?.[key];
    if (!content) return callback(null, content);

    resetRegex(regexs.ENCODING_FORMAT);
    const encoding = ((data[key]?.encoding || 'utf8')).toString().toLowerCase()
        .replace(regexs.ENCODING_FORMAT, '');
    const { path, href } = content;

    // 处理不同类型的content
    const handleContent = async () => {
        if (typeof content === 'object') {
            // 如果content是流，则解析流
            if (typeof content.pipe === 'function') {
                return _resolveStream(content, (err, value) => {
                    if (err) return callback(err);
                    // 不能两次流式传输相同内容，所以需要替换流对象
                    const target = data[key].content ? data[key] : data;
                    target.content ? target.content = value : data[key] = value;
                    callback(null, value);
                });
            }

            const targetPath = path || href;
            // 处理HTTP URL
            if (regexs.HTTP_URL.test(targetPath)) {
                return _resolveStream(nmfetch(targetPath), callback);
            }
            // 处理Data URI
            else if (regexs.DATA_URL.test(targetPath)) {
                const parsedDataUri = parseDataURI(targetPath);
                return callback(null, parsedDataUri?.data ? parsedDataUri.data : Buffer.from(0));
            }
            // 处理文件路径
            else if (path) {
                return _resolveStream(fs.createReadStream(path), callback);
            }
        }

        // 处理特定编码的字符串
        let finalContent = content;
        if (typeof data[key]?.content === 'string' && !['utf8', 'usascii', 'ascii'].includes(encoding)) {
            finalContent = Buffer.from(data[key].content, encoding);
        }

        setImmediate(() => callback(null, finalContent));
    };

    handleContent().catch(err => callback(err));
    return promise;
}