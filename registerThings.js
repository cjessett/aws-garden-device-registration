require('dotenv').config();

const util = require('util');
const fs = require('fs');
const https = require('https');
const exec = util.promisify(require('child_process').exec);

const AWS = require('aws-sdk');
AWS.config.region = 'us-west-2';

const iot = new AWS.Iot();
const s3 = new AWS.S3();

const DEVICES = [{ name: 'ss-1', chipId: '123' }, { name: 'ss-2', chipId: '456' }];

let RETRY = 0;
const { BUCKET_NAME, BUCKET_FILE, ROLE_ARN, TEMPLATE } = process.env;

function to(promise) {
  return promise.then(data => [null, data]).catch(err => [err]);
}

function saveCertificate({ CertificatePem, ResourceArns: { thing } }) {
  const name = thing.split('thing/')[1];
  const crtPath = `./certs/crt/${name}.crt`;
  fs.writeFileSync(crtPath, CertificatePem);
}

function uploadFile(file) {
  if (!fs.existsSync(file)) return Promise.reject('file does not exist');
  const params = { Bucket: BUCKET_NAME, Key: file, Body: fs.createReadStream(file) };
  return s3.upload(params).promise();
}

async function createThing({ name, chipId }) {
  const keyPath = `./certs/key/${name}.key`;
  const csrPath = `./certs/csr/${name}.csr`;
  const subj = '/C=US/ST=CA/O=SmartGarden';
  const command = `openssl req -new -newkey rsa:2048 -nodes -keyout ${keyPath} -out ${csrPath} -subj ${subj}`;
  const [err] = await to(exec(command));
  if (err) return Promise.reject(err);
  const csr = fs.readFileSync(csrPath, 'utf8').replace(/\n/g, '');
  return { ThingName: name, SerialNumber: chipId, CSR: csr };
}

async function generateThingProvisioningData(devices, outFile) {
  // iterate through thing data creating things (name, chipId)
  const things = await Promise.all(devices.map(createThing))
  // create data file
  fs.writeFileSync(outFile, things.map(JSON.stringify).join('\n'));
}

async function registerThings(devices) {
  let err, taskId;
  // generate thing data
  [err] = await to(generateThingProvisioningData(devices, BUCKET_FILE));
  if (err) return Promise.reject(err);
  // upload to S3
  [err] = await to(uploadFile(BUCKET_FILE));
  if (err) return Promise.reject(err);
  // start task
  const templateBody = fs.readFileSync(TEMPLATE, 'utf8');
  const params = { inputFileBucket: BUCKET_NAME, inputFileKey: BUCKET_FILE, roleArn: ROLE_ARN, templateBody };
  return iot.startThingRegistrationTask(params).promise();
}

async function checkRegistrationStatus(taskId) {
  async function retry(res, rej) {
    if (RETRY > 10) return rej('retries exceeded');
    const [err, data] = await to(iot.describeThingRegistrationTask({ taskId }).promise());
    if (err) return rej(err);

    const { status, percentageProgress } = data;
    console.log(`Status: ${status}: ${percentageProgress}%`);

    if (status === 'Completed') return res(status);
    RETRY++
    setTimeout(async () => await retry(res, rej), 1000);
  }
  return new Promise(retry);
}

async function getCertificates(taskId) {
  return new Promise(async (resolve, reject) => {
    const [err, data] = await to(iot.listThingRegistrationTaskReports({ taskId, reportType: 'RESULTS' }).promise());
    if (err) return reject(err);

    https.get(data.resourceLinks[0], (res) => {
      let data = '';
      console.log('Getting Certs...');

      res.on('data', d => data += d);
      res.on('end', () => {
        const resources = data.split('\n');
        const certs = resources
          .slice(0, resources.length - 1)
          .map(JSON.parse)
          .map(r => r.response)
          .map(saveCertificate);
      });

    }).on('error', e => reject(e));
  });
}

async function main(devices) {
  fs.mkdirSync('./certs');
  fs.mkdirSync('./certs/key');
  fs.mkdirSync('./certs/csr');
  fs.mkdirSync('./certs/crt');
  let err, certs;

  [err, res] = await to(registerThings(devices));
  if (err) return Promise.reject(err);

  const { taskId } = res;
  [err] = await to(checkRegistrationStatus(taskId));
  if (err) return Promise.reject(err);

  [err, certs] = await to(getCertificates(taskId));
  if (err) return Promise.reject(err);

  console.log(`Certificates in ${certs}`)
}

main(DEVICES).catch(console.error);
