const fs = require('fs');
const path = require('path');

// 检查项目根目录
const packageDir = __dirname;
const projectRoot = path.resolve(packageDir, '../..'); // 向上两级到项目根目录
const projectMailPath = path.join(projectRoot, 'Mail.js');

// 示例文件内容 - 通用邮箱配置模板
const formattedContent = `const mail = require('lunjack-mail');
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
    text: '这是一封测试邮件',         // 纯文本内容
    html: '<b>这是一封测试邮件</b>'   // HTML内容（可选）
}, (error, info) => {
    if (error)  console.error('发送失败:', error);
    else console.log('发送成功:', info.response);
});

// 也可以使用async/await方式
// async function sendEmail() {
    // try {
        // const info = await transporter.sendMail({
            // from: 'your-email@example.com',
            // to: 'recipient@example.com',
            // subject: '异步测试邮件',
            // text: '这是一封使用async/await发送的测试邮件'
        // });
        // console.log('异步发送成功:', info.response);
    // } catch (error) {
        // console.error('异步发送失败:', error);
    // }
// }

// 导出transporter以便在其他文件中使用
module.exports = transporter;`;

// 检查并创建示例文件
function checkAndCreateMailFile() {
    console.log('🔍 检查 Mail.js 文件...');
    console.log('📁 项目根目录: ' + projectRoot);
    try {
        // 检查项目根目录
        if (fs.existsSync(projectMailPath)) return true;

        // 在项目根目录创建
        console.log('⚠️  在项目根目录未找到 Mail.js 文件，正在创建...');

        fs.writeFileSync(projectMailPath, formattedContent, 'utf8');
        console.log('✓ 已创建 Mail.js 示例文件: ' + projectMailPath);
        console.log('💡 请编辑 Mail.js 文件，根据您的邮箱服务商配置SMTP信息');
        return true;
    } catch (error) {
        console.error('✗ 创建 Mail.js 文件失败:', error.message);
        return false;
    }
}

// 执行脚本并导出函数
if (require.main === module) checkAndCreateMailFile();
module.exports = { checkAndCreateMailFile };