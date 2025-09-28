module.exports = {
    upgrade: true,
    // 不进行升级的包
    reject: [
        // API变更破坏了现有测试
        'proxy',

        // API变更
        'eslint',
        'eslint-config-prettier'
    ]
};