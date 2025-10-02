# lunjack-mail - 轻量级邮件发送库

一个简单易用的 Node.js 邮件发送库，支持多种邮件服务商，无需依赖外部邮件测试服务。

## 项目运行导图

```mermaid
graph TD
    A[开始使用] --> B[安装依赖]
    B --> C[配置邮件参数]
    C --> D[验证配置]
    D --> E{配置是否有效?}
    E -->|是| F[创建传输器]
    E -->|否| C
    F --> G[发送邮件]
    G --> H{发送结果}
    H -->|成功| I[显示成功信息]
    H -->|失败| J[显示错误信息]
    I --> K[结束]
    J --> K
```

## 安装

```bash
npm i lunjack-mail
```

## 优势

- **安全性**：不依赖外部服务，数据完全可控
- **真实性**：使用真实邮箱测试，结果更准确
- **灵活性**：支持各种邮件服务商（Gmail、Outlook、QQ邮箱等）
- **简单性**：安装时在项目根目录动态创建邮件示例,配置更直接，无需理解复杂的测试服务概念
- **配置验证**：发送前可验证配置,确保必要的配置项已填写
- **清晰的错误提示**：指导用户正确使用

## 快速开始

### 基本使用

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

### 常用邮箱服务商配置参考

#### Gmail
```javascript
const transporter = mail.createTransport({
    host: 'smtp.gmail.com',
    port: 587,
    secure: false,
    auth: {
        user: 'your-email@gmail.com',
        pass: 'your-app-password' // 需要启用两步验证并使用应用专用密码
    }
});
```

#### QQ邮箱
```javascript
const transporter = mail.createTransport({
    host: 'smtp.qq.com',
    port: 587,
    secure: false,
    auth: {
        user: 'your-email@qq.com',
        pass: 'your-authorization-code' // QQ邮箱授权码，非登录密码
    }
});
```

#### 163邮箱
```javascript
const transporter = mail.createTransport({
    host: 'smtp.163.com',
    port: 465,
    secure: true,
    auth: {
        user: 'your-email@163.com',
        pass: 'your-authorization-code' // 163邮箱授权码
    }
});
```

## 配置验证

在创建传输器前验证配置的有效性，避免运行时错误。

### 验证配置示例

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

## 高级用法

### 发送带附件的邮件

```javascript
transporter.sendMail({
    from: 'your-email@example.com',
    to: 'recipient@example.com',
    subject: '带附件的测试邮件',
    text: '这是一封带附件的测试邮件',
    html: '<b>这是一封带附件的测试邮件</b>',
    attachments: [
        {
            filename: 'document.pdf',
            path: './documents/document.pdf'
        },
        {
            filename: 'image.png',
            content: 'base64 encoded string', // 或使用 path 参数
            encoding: 'base64'
        }
    ]
}, (error, info) => {
    if (error) console.error('发送失败:', error);
    else console.log('发送成功:', info.response);
});
```

### 使用 Promise 语法

```javascript
// 使用 async/await
async function sendEmail() {
    try {
        const info = await transporter.sendMail({
            from: 'your-email@example.com',
            to: 'recipient@example.com',
            subject: '测试邮件',
            text: '这是一封测试邮件'
        });
        console.log('邮件发送成功:', info.messageId);
    } catch (error) {
        console.error('邮件发送失败:', error);
    }
}

sendEmail();
```

## 错误处理

库提供了详细的错误信息，帮助您快速定位问题：

- **配置错误**：如缺少必要参数、无效的端口号等
- **连接错误**：如无法连接到SMTP服务器
- **认证错误**：如用户名或密码错误
- **发送错误**：如收件人地址无效、邮件被拒绝等

## 注意事项

1. 确保您的邮箱已开启SMTP服务
2. 部分邮箱服务商需要使用授权码而非登录密码
3. 建议在生产环境中使用环境变量存储敏感信息
4. 发送频率过高可能被邮箱服务商限制

## 许可证

ISC