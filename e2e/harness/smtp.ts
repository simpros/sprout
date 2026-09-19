import { Socket } from "node:net";

export function smtpCommand(socket: Socket, line: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = "";
    const onData = (chunk: Buffer) => {
      buf += chunk.toString();
      if (buf.includes("\r\n")) {
        socket.off("data", onData);
        resolve(buf);
      }
    };
    socket.on("data", onData);
    socket.once("error", reject);
    socket.write(`${line}\r\n`);
  });
}

export async function sendMail(opts: {
  host: string;
  port: number;
  from: string;
  fromName: string;
  to: string;
  subject: string;
  body: string;
}): Promise<void> {
  const socket = new Socket();
  await new Promise<void>((resolve, reject) => {
    socket.once("error", reject);
    socket.connect(opts.port, opts.host, () => resolve());
  });
  try {
    await new Promise<string>((resolve, reject) => {
      let buf = "";
      socket.on("data", function onData(chunk: Buffer) {
        buf += chunk.toString();
        if (buf.includes("\r\n")) {
          socket.off("data", onData);
          resolve(buf);
        }
      });
      socket.once("error", reject);
    });
    await smtpCommand(socket, `EHLO e2e`);
    await smtpCommand(socket, `MAIL FROM:<${opts.from}>`);
    await smtpCommand(socket, `RCPT TO:<${opts.to}>`);
    await smtpCommand(socket, `DATA`);
    const payload = [
      `From: ${opts.fromName} <${opts.from}>`,
      `To: ${opts.to}`,
      `Subject: ${opts.subject}`,
      ``,
      opts.body,
      `.`,
    ].join("\r\n");
    await smtpCommand(socket, payload);
    await smtpCommand(socket, `QUIT`);
  } finally {
    socket.destroy();
  }
}
