## 优势
- **安全性**：不依赖外部服务，数据完全可控
- **真实性**：使用真实邮箱测试，结果更准确
- **灵活性**：支持各种邮件服务商（Gmail、Outlook、QQ邮箱等）
- **简单性**：安装时在项目根目录动态创建邮件示例,配置更直接，无需理解复杂的测试服务概念
- **配置验证**：发送前可验证配置,确保必要的配置项已填写
- **清晰的错误提示**：指导用户正确使用

## 使用示例

```javascript
const mail = require('lunjack-mail');
// 邮箱配置示例 - 请根据您的邮箱服务商修改以下配置
const transporter = mail.createTransport({

    // 邮箱服务商SMTP服务器地址(Gmail: 'smtp.gmail.com'; QQ: 'smtp.qq.com'; 163: 'smtp.163.com')
    host: 'smtp.your-email-provider.com',

    // 端口号，通常为 465(SSL) 或 587(TLS)
    port: 587,

    // 是否使用SSL/TLS
    secure: false, // true for 465, false for other ports

    auth: {
        user: 'your-email@example.com', // 您的邮箱地址

        // 您的邮箱密码或授权码(Gmail需要应用专用密码，QQ邮箱需要授权码)
        pass: 'your-password-or-app-password'
    }
});

// 发送邮件示例
transporter.sendMail({
    from: 'your-email@example.com', // 发件人
    to: 'recipient@example.com',    // 收件人
    subject: '测试邮件',             // 邮件主题
    text: '这是一封测试邮件(text)',         // 纯文本内容
    html: '<b>这是一封测试邮件(html)</b>'   // HTML内容（可选;注:html内容优先级高于纯文本内容)
}, (error, info) => {
    if (error)  console.error('发送失败:', error);
    else console.log('发送成功:', info.response);
});
```

## 验证配置示例

```javascript
const mail = require('lunjack-mail');

// 1. 验证URL格式配置
const urlConfig = 'smtps://user:pass@smtp.your-email-provider.com:465';
const validation1 = mail.validateConfig(urlConfig);
if (!validation1.valid) {
    console.error('配置错误:', validation1.errors);
} else if (validation1.warnings) {
    console.warn('配置警告:', validation1.warnings);
}

// 2. 验证对象配置
const objectConfig = {
    host: 'smtp.your-email-provider.com',
    port: 587,
    secure: false,
    auth: {
        user: 'your-email@example.com',
        pass: 'password'
    }
};
const validation2 = mail.validateConfig(objectConfig);
if (validation2.valid) {
    const transporter = mail.createTransport(objectConfig);
    console.log('传输器创建成功');
} else {
    console.error('配置无效，无法创建传输器:', validation2.errors);
}

// 3. 验证无效配置
const invalidConfig = {
   host: 'smtp.your-email-provider.com',
    port: 70000, // 无效端口
    auth: {
        user: 'your-email@example.com'
        // 缺少密码
    }
};
const validation3 = mail.validateConfig(invalidConfig);
console.log('无效配置验证结果:', validation3);
```
```javascript
/*
// 用法示例：

// 1. 创建DKIM实例
let dkim = new DKIM({
    domainName: 'example.com',        // 域名，用于标识签名来源
    keySelector: 'key-selector',      // 密钥选择器，用于在DNS中查找公钥
    privateKey,                       // RSA私钥，用于生成数字签名
    cacheDir: '/tmp'                  // 缓存目录，用于处理大邮件时的临时存储
});

// 2. 对邮件进行签名
dkim.sign(input).pipe(process.stdout);

// 参数说明：
// - input: 输入邮件内容，可以是以下类型：
//   * Stream (流)：可读流，包含RFC822格式的原始邮件
//   * String (字符串)：邮件内容的字符串形式
//   * Buffer (缓冲区)：邮件内容的二进制缓冲区
//
// - 返回值：一个可读流，包含已添加DKIM签名的完整邮件
//
// 工作流程：
// 1. 解析输入邮件的头部和正文
// 2. 对邮件正文进行规范化处理并计算哈希值
// 3. 使用私钥对指定邮件头字段和正文哈希进行签名
// 4. 在邮件头部添加DKIM-Signature字段
// 5. 输出完整的已签名邮件
*/
```
---
## DKIM签名使用示例：

```javascript
// 引入DKIM模块
const DKIM = require('./dkim');

// 示例1：基本用法
const privateKey = `-----BEGIN RSA PRIVATE KEY-----
...你的私钥内容...
-----END RSA PRIVATE KEY-----`;

const dkim = new DKIM({
    domainName: 'mycompany.com',     // 你的域名
    keySelector: '2024',             // 密钥版本标识，通常用年月
    privateKey: privateKey,          // RSA私钥
    cacheDir: '/tmp/dkim-cache'      // 可选：缓存目录
});

// 示例2：签名字符串格式的邮件
const emailString = `From: sender@mycompany.com
To: recipient@example.com
Subject: 测试邮件

这是邮件正文内容。`;

const signedStream = dkim.sign(emailString);
signedStream.pipe(process.stdout);  // 输出到控制台
// 或者保存到文件：signedStream.pipe(fs.createWriteStream('signed_email.eml'));

// 示例3：签名流式输入的邮件
const fileStream = fs.createReadStream('original_email.eml');
dkim.sign(fileStream).pipe(fs.createWriteStream('signed_email.eml'));

// 示例4：使用多个密钥（用于密钥轮换）
const dkimMulti = new DKIM({
    keys: [
        {
            domainName: 'mycompany.com',
            keySelector: '2024',
            privateKey: newPrivateKey
        },
        {
            domainName: 'mycompany.com',
            keySelector: '2023',
            privateKey: oldPrivateKey  // 旧密钥，用于兼容性
        }
    ]
});
// 这样会为同一封邮件生成两个DKIM签名
```

## 关键概念说明：

- **domainName**：你的域名，收件方会用这个域名在DNS中查找公钥
- **keySelector**：密钥标识符，允许同一域名下有多个密钥
- **privateKey**：RSA私钥，用于生成数字签名
- **DNS记录**：需要在域名DNS中添加TXT记录，格式为：`[keySelector]._domainkey.[domainName]`，包含公钥信息

这样邮件接收方就能验证邮件确实来自你的域名且未被篡改。