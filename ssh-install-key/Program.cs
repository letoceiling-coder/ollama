using System.Diagnostics;
using System.Text;
using Renci.SshNet;

const string Host = "89.169.39.244";
const string User = "root";
const int Port = 22;

var pubkeyPath = Path.Combine(
    Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
    ".ssh", "id_ed25519_beget_instinctive.pub");

if (!File.Exists(pubkeyPath))
{
    Console.Error.WriteLine("Нет файла ключа: " + pubkeyPath);
    Environment.Exit(1);
}

var password = Environment.GetEnvironmentVariable("BEGET_ROOT_PASSWORD");
if (string.IsNullOrEmpty(password))
{
    Console.Error.WriteLine("Задайте пароль временно в окружении, например в PowerShell:");
    Console.Error.WriteLine("  $env:BEGET_ROOT_PASSWORD = 'ваш_пароль_root'");
    Console.Error.WriteLine("  dotnet run --project ssh-install-key");
    Environment.Exit(1);
}

var pubkey = File.ReadAllText(pubkeyPath).Trim();
if (string.IsNullOrWhiteSpace(pubkey) || !pubkey.StartsWith("ssh-", StringComparison.Ordinal))
{
    Console.Error.WriteLine("Некорректное содержимое .pub файла.");
    Environment.Exit(1);
}

var methods = new PasswordAuthenticationMethod(User, password);
var conn = new ConnectionInfo(Host, Port, User, methods)
{
    Timeout = TimeSpan.FromSeconds(30),
};

using var client = new SshClient(conn);
client.HostKeyReceived += (_, e) => e.CanTrust = true;

try
{
    client.Connect();
}
catch (Exception ex)
{
    Console.Error.WriteLine("Не удалось подключиться: " + ex.Message);
    Environment.Exit(1);
}

try
{
    Run(client, "install -d -m 700 /root/.ssh");

    var existing = Run(client, "cat /root/.ssh/authorized_keys 2>/dev/null || true");
    var lines = existing.Result.Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
    if (Array.IndexOf(lines, pubkey) >= 0)
    {
        Console.WriteLine("Ключ уже есть в /root/.ssh/authorized_keys — пропуск.");
    }
    else
    {
        var b64 = Convert.ToBase64String(Encoding.UTF8.GetBytes(pubkey + "\n"));
        var append = Run(client, $"printf '%s' '{b64}' | base64 -d >> /root/.ssh/authorized_keys");
        if (append.ExitStatus != 0)
        {
            Console.Error.WriteLine("Ошибка добавления ключа: " + append.Error);
            Environment.Exit(1);
        }
        Console.WriteLine("Публичный ключ добавлен.");
    }

    Run(client, "chmod 600 /root/.ssh/authorized_keys");
    Run(client, "chown root:root /root/.ssh/authorized_keys /root/.ssh 2>/dev/null || true");

    var probe = Run(client, "command -v systemctl >/dev/null 2>&1 && systemctl is-active ssh 2>/dev/null || echo unknown");
    Console.WriteLine("Статус ssh: " + probe.Result.Trim());
    Console.WriteLine("Готово. Подключение: ssh -i $env:USERPROFILE\\.ssh\\id_ed25519_beget_instinctive root@" + Host);
}
finally
{
    if (client.IsConnected)
        client.Disconnect();
}

static SshCommand Run(SshClient client, string command)
{
    var cmd = client.RunCommand(command);
    if (cmd.ExitStatus != 0 && !string.IsNullOrWhiteSpace(cmd.Error))
        Debug.WriteLine(command + ": " + cmd.Error);
    return cmd;
}
