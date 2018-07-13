const fs = require('fs');
const util = require('util');
const path = require('path');
const exec = util.promisify(require('child_process').exec);

const CRTPath = name => path.resolve(`./certs/crt/${name}.crt`);
const KEYPath = name => path.resolve(`./certs/key/${name}.key`);
const CSRPath = path.resolve('./certs/csr');
const BINPath = path.resolve('./certs/bin');

const topDir = process.cwd();

async function toBinary(inFile) {
  const binaryCmd = `xxd -c 100000000 -i ${inFile} >> secrets.h`;
  const { stderr } = await exec(binaryCmd);
  if (stderr) console.error(stderr);
}

async function convertCert({ deviceBinPath, crtPath }) {
  const outFile = `${deviceBinPath}/cert.der`;
  const cmd = `openssl x509 -in ${crtPath} -out ${outFile} -outform DER`;
  await exec(cmd);
  return 'cert.der';
}

async function convertKey({ deviceBinPath, keyPath }) {
  const outFile = `${deviceBinPath}/private.der`;
  const cmd = `openssl rsa -in ${keyPath} -out ${outFile} -outform DER`;
  await exec(cmd);
  return 'private.der';
}

async function convertToDER(device) {
  fs.mkdirSync(device.deviceBinPath);

  await convertCert(device);
  await convertKey(device);
}

function generateSecrets(device) {
  const deviceBinPath = path.resolve(`${BINPath}/${device}`);
  process.chdir(deviceBinPath);
  const files = fs.readdirSync(deviceBinPath)
  files.forEach(toBinary);
}

async function main() {
  const filePaths = fs.readdirSync(CSRPath)

  fs.mkdirSync(BINPath);

  const devices = filePaths
    .map(p => path.basename(p, '.csr'))
    .map(name => {
      const deviceBinPath = path.resolve(`${BINPath}/${name}`);
      return { deviceBinPath, crtPath: CRTPath(name), keyPath: KEYPath(name) };
    });

  await Promise.all(devices.map(convertToDER));

  const deviceBins = fs.readdirSync(BINPath);

  deviceBins.forEach(generateSecrets);

  const secrets = deviceBins.map(d => `${path.resolve(d)}/secrets.h`);
  console.log(secrets);
}

main()
