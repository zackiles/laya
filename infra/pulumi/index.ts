import * as gcp from '@pulumi/gcp'
import * as pulumi from '@pulumi/pulumi'

const stack = pulumi.getStack()
const settings = new pulumi.Config('laya')
const gcpConfig = new pulumi.Config('gcp')

const project = gcpConfig.require('project')
const region = gcpConfig.get('region') ?? 'northamerica-northeast1'
const name = 'laya'
const image = settings.get('image')

const iapMembers = (settings.get('iapMembers') ?? 'user:zachary.iles@nesto.ca')
  .split(',')
  .map((entry) => entry.trim())
  .filter(Boolean)

const services = ['run', 'artifactregistry', 'iap', 'vpcaccess'].map(
  (service) =>
    new gcp.projects.Service(`api-${service}`, {
      project,
      service: `${service}.googleapis.com`,
      disableOnDestroy: false,
    }),
)

const opts = { dependsOn: services }

const registry = new gcp.artifactregistry.Repository(
  'images',
  {
    project,
    location: region,
    repositoryId: name,
    format: 'DOCKER',
    description: 'Container images for the Laya decision trial',
    dockerConfig: { immutableTags: true },
  },
  opts,
)

const projectNumber = gcp.organizations.getProjectOutput({ projectId: project }).number

// Cloud Build pushes the image. Which identity builds depends on the project default;
// both of the accounts Google uses are granted writer on this repository.
for (const [key, member] of [
  ['cloudbuild', pulumi.interpolate`serviceAccount:${projectNumber}@cloudbuild.gserviceaccount.com`],
  ['compute', pulumi.interpolate`serviceAccount:${projectNumber}-compute@developer.gserviceaccount.com`],
] as const) {
  new gcp.artifactregistry.RepositoryIamMember(
    `builder-${key}`,
    {
      project,
      location: registry.location,
      repository: registry.name,
      role: 'roles/artifactregistry.writer',
      member,
    },
    opts,
  )
}

const runtime = new gcp.serviceaccount.Account('runtime', {
  project,
  accountId: `${name}-run`,
  displayName: 'Laya Cloud Run runtime',
})

new gcp.projects.IAMMember('runtime-logging', {
  project,
  role: 'roles/logging.logWriter',
  member: pulumi.interpolate`serviceAccount:${runtime.email}`,
})

// Same connector the StrongDM bot attaches. The deployer is not granted to read the shared VPC,
// so this is the connector's name rather than a lookup.
const vpcAccess = {
  connector: `projects/${project}/locations/${region}/connectors/serverless-connector`,
  egress: 'PRIVATE_RANGES_ONLY',
}

const envs = [
  { name: 'LAYA_PORT', value: '8080' },
  { name: 'LAYA_HOST', value: '0.0.0.0' },
  { name: 'LAYA_DEVICE', value: 'cpu' },
  { name: 'LAYA_PRELOAD', value: '1' },
  { name: 'LAYA_MODELS', value: 'english,multilingual' },
  { name: 'LAYA_DEFAULT_MODEL', value: 'multilingual' },
  { name: 'LAYA_MAX_LOADED', value: '2' },
  { name: 'LAYA_THREADS', value: '4' },
  { name: 'OMP_NUM_THREADS', value: '4' },
  { name: 'LAYA_MAX_CONCURRENT', value: '1' },
  { name: 'HF_HUB_OFFLINE', value: '1' },
  { name: 'TORCH_DISABLE_NATIVE_JIT', value: '1' },
]

// The service waits for a digest. Creating it against a floating tag, or before the bake
// exists, would roll out a process that cannot load checkpoints offline.
const service = image
  ? new gcp.cloudrunv2.Service(
      'service',
      {
        project,
        location: region,
        name,
        ingress: 'INGRESS_TRAFFIC_ALL',
        iapEnabled: true,
        deletionProtection: false,
        labels: { stage: 'sandbox', trial: 'laya' },
        template: {
          serviceAccount: runtime.email,
          timeout: '120s',
          maxInstanceRequestConcurrency: 1,
          scaling: { minInstanceCount: 1, maxInstanceCount: 3 },
          vpcAccess,
          containers: [
            {
              image,
              // Keeps the image entrypoint (secret-file loader) and replaces the one-shot
              // quickstart CMD. laya-serve reads LAYA_PORT and ignores Cloud Run's PORT.
              args: ['laya-serve'],
              resources: {
                limits: { cpu: '4', memory: '8Gi' },
                cpuIdle: true,
                startupCpuBoost: true,
              },
              ports: { containerPort: 8080 },
              envs,
              startupProbe: {
                httpGet: { path: '/health', port: 8080 },
                initialDelaySeconds: 0,
                timeoutSeconds: 10,
                periodSeconds: 30,
                failureThreshold: 10,
              },
            },
          ],
        },
      },
      { dependsOn: [...services, registry, runtime] },
    )
  : undefined

if (service) {
  new gcp.cloudrunv2.ServiceIamMember('iap-invoker', {
    project,
    location: service.location,
    name: service.name,
    role: 'roles/run.invoker',
    member: pulumi.interpolate`serviceAccount:service-${projectNumber}@gcp-sa-iap.iam.gserviceaccount.com`,
  })

  for (const member of iapMembers) {
    new gcp.iap.WebCloudRunServiceIamMember(`iap-access-${member.replace(/[^a-z0-9]/gi, '-')}`, {
      project,
      location: region,
      cloudRunServiceName: service.name,
      role: 'roles/iap.httpsResourceAccessor',
      member,
    })
  }
}

export const url = service?.uri
export const runtimeAccount = runtime.email
export const imageRepository = pulumi.interpolate`${region}-docker.pkg.dev/${project}/${registry.repositoryId}`
export const stackName = stack
