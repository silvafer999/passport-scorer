import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import * as awsx from "@pulumi/awsx";

// The following vars are not allowed to be undefined, hence the `${...}` magic

let route53Zone = `${process.env["ROUTE_53_ZONE"]}`;
export const domain = `api.scorer.${process.env["DOMAIN"]}`;
export const publicServiceUrl = `https://${domain}`;

let SCORER_SERVER_SSM_ARN = `${process.env["SCORER_SERVER_SSM_ARN"]}`;
let dbUsername = `${process.env["DB_USER"]}`;
let dbPassword = pulumi.secret(`${process.env["DB_PASSWORD"]}`);
let dbName = `${process.env["DB_NAME"]}`;

export const dockerGtcPassportScorerImage = `${process.env["DOCKER_GTC_PASSPORT_SCORER_IMAGE"]}`;
export const dockerGtcPassportVerifierImage = `${process.env["DOCKER_GTC_PASSPORT_VERIFIER_IMAGE"]}`;

//////////////////////////////////////////////////////////////
// Set up VPC
//////////////////////////////////////////////////////////////

const vpc = new awsx.ec2.Vpc("scorer", {
  subnets: [{ type: "public" }, { type: "private", mapPublicIpOnLaunch: true }],
});

export const vpcID = vpc.id;
export const vpcPrivateSubnetIds = vpc.privateSubnetIds;
export const vpcPublicSubnetIds = vpc.publicSubnetIds;
export const vpcPrivateSubnetId1 = vpcPrivateSubnetIds.then(
  (values) => values[0]
);
export const vpcPublicSubnetId1 = vpcPublicSubnetIds.then(
  (values) => values[0]
);
export const vpcPrivateSubnetId2 = vpcPrivateSubnetIds.then(
  (values) => values[1]
);
export const vpcPublicSubnetId2 = vpcPublicSubnetIds.then(
  (values) => values[1]
);

export const vpcPublicSubnet1 = vpcPublicSubnetIds.then((subnets) => {
  return subnets[0];
});

//////////////////////////////////////////////////////////////
// Set up RDS instance
//////////////////////////////////////////////////////////////
let dbSubnetGroup = new aws.rds.SubnetGroup(`scorer-db-subnet`, {
  subnetIds: vpcPrivateSubnetIds,
});

const db_secgrp = new aws.ec2.SecurityGroup(`scorer-db-secgrp`, {
  description: "Security Group for DB",
  vpcId: vpc.id,
  ingress: [
    {
      protocol: "tcp",
      fromPort: 5432,
      toPort: 5432,
      cidrBlocks: ["0.0.0.0/0"],
    },
  ],
  egress: [
    {
      protocol: "-1",
      fromPort: 0,
      toPort: 0,
      cidrBlocks: ["0.0.0.0/0"],
    },
  ],
});

const postgresql = new aws.rds.Instance(
  `scorer-db`,
  {
    allocatedStorage: 10,
    engine: "postgres",
    // engineVersion: "5.7",
    instanceClass: "db.t3.large",
    dbName: dbName,
    password: dbPassword,
    username: dbUsername,
    skipFinalSnapshot: true,
    dbSubnetGroupName: dbSubnetGroup.id,
    vpcSecurityGroupIds: [db_secgrp.id],
    deletionProtection: true,
    backupRetentionPeriod: 5,
  },
  { protect: true }
);

export const rdsEndpoint = postgresql.endpoint;
export const rdsArn = postgresql.arn;
export const rdsConnectionUrl = pulumi.secret(
  pulumi.interpolate`psql://${dbUsername}:${dbPassword}@${rdsEndpoint}/${dbName}`
);
export const rdsId = postgresql.id;

//////////////////////////////////////////////////////////////
// Set up Redis
//////////////////////////////////////////////////////////////

const redisSubnetGroup = new aws.elasticache.SubnetGroup(
  "scorer-redis-subnet",
  {
    subnetIds: vpcPrivateSubnetIds,
  }
);

const secgrp_redis = new aws.ec2.SecurityGroup("scorer-redis-secgrp", {
  description: "scorer",
  vpcId: vpc.id,
  ingress: [
    {
      protocol: "tcp",
      fromPort: 6379,
      toPort: 6379,
      cidrBlocks: ["0.0.0.0/0"],
    },
  ],
  egress: [
    {
      protocol: "-1",
      fromPort: 0,
      toPort: 0,
      cidrBlocks: ["0.0.0.0/0"],
    },
  ],
});

const redis = new aws.elasticache.Cluster("scorer-redis", {
  engine: "redis",
  engineVersion: "4.0.10",
  nodeType: "cache.m5.large",
  numCacheNodes: 1,
  port: 6379,
  subnetGroupName: redisSubnetGroup.name,
  securityGroupIds: [secgrp_redis.id],
});

export const redisPrimaryNode = redis.cacheNodes[0];
// export const redisConnectionUrl = pulumi.interpolate`rediscache://${redisPrimaryNode.address}:${redisPrimaryNode.port}/0?client_class=django_redis.client.DefaultClient`
export const redisCacheOpsConnectionUrl = pulumi.interpolate`redis://${redisPrimaryNode.address}:${redisPrimaryNode.port}/0`;

//////////////////////////////////////////////////////////////
// Set up ALB and ECS cluster
//////////////////////////////////////////////////////////////

const cluster = new awsx.ecs.Cluster("scorer", { vpc });
// export const clusterInstance = cluster;
export const clusterId = cluster.id;

// Generate an SSL certificate
const certificate = new aws.acm.Certificate("cert", {
  domainName: domain,
  tags: {
    Environment: "review",
  },
  validationMethod: "DNS",
});

const certificateValidationDomain = new aws.route53.Record(
  `${domain}-validation`,
  {
    name: certificate.domainValidationOptions[0].resourceRecordName,
    zoneId: route53Zone,
    type: certificate.domainValidationOptions[0].resourceRecordType,
    records: [certificate.domainValidationOptions[0].resourceRecordValue],
    ttl: 600,
  }
);

const certificateValidation = new aws.acm.CertificateValidation(
  "certificateValidation",
  {
    certificateArn: certificate.arn,
    validationRecordFqdns: [certificateValidationDomain.fqdn],
  },
  { customTimeouts: { create: "30s", update: "30s" } }
);

// Create bucket for access logs
const accessLogsBucket = new aws.s3.Bucket(`gitcoin-scorer-access-logs`, {
  acl: "private",
  forceDestroy: true,
});

const serviceAccount = aws.elb.getServiceAccount({});

const accessLogsBucketPolicyDocument = aws.iam.getPolicyDocumentOutput({
  statements: serviceAccount.then((serviceAccount) => [
    {
      effect: "Allow",
      principals: [
        {
          type: "AWS",
          identifiers: [pulumi.interpolate`${serviceAccount.arn}`],
        },
      ],
      actions: ["s3:PutObject"],
      resources: [
        pulumi.interpolate`arn:aws:s3:::${accessLogsBucket.id}/AWSLogs/*`,
      ],
    },
    {
      effect: "Allow",
      principals: [
        {
          type: "Service",
          identifiers: ["logdelivery.elb.amazonaws.com"],
        },
      ],
      actions: ["s3:GetBucketAcl"],
      resources: [pulumi.interpolate`arn:aws:s3:::${accessLogsBucket.id}`],
    },
  ]),
});

const accessLogsBucketPolicy = new aws.s3.BucketPolicy(
  `gitcoin-accessLogs-policy`,
  {
    bucket: accessLogsBucket.id,
    policy: accessLogsBucketPolicyDocument.apply(
      (accessLogsBucketPolicyDocument) => accessLogsBucketPolicyDocument.json
    ),
  }
);

// Creates an ALB associated with our custom VPC.
const alb = new awsx.lb.ApplicationLoadBalancer(`scorer-service`, {
  vpc,
  accessLogs: {
    bucket: accessLogsBucket.bucket,
    enabled: true,
  },
});

// Listen to HTTP traffic on port 80 and redirect to 443
const httpListener = alb.createListener("web-listener", {
  port: 80,
  protocol: "HTTP",
  defaultAction: {
    type: "redirect",
    redirect: {
      protocol: "HTTPS",
      port: "443",
      statusCode: "HTTP_301",
    },
  },
});

// Target group with the port of the Docker image
const target = alb.createTargetGroup("scorer-target", {
  vpc,
  port: 80,
  healthCheck: { path: "/health/", unhealthyThreshold: 5 },
});

// Listen to traffic on port 443 & route it through the target group
const httpsListener = target.createListener("scorer-listener", {
  port: 443,
  certificateArn: certificateValidation.certificateArn,
});

// Create a DNS record for the load balancer
const www = new aws.route53.Record("scorer", {
  zoneId: route53Zone,
  name: domain,
  type: "A",
  aliases: [
    {
      name: httpsListener.endpoint.hostname,
      zoneId: httpsListener.loadBalancer.loadBalancer.zoneId,
      evaluateTargetHealth: true,
    },
  ],
});

const dpoppEcsRole = new aws.iam.Role("dpoppEcsRole", {
  assumeRolePolicy: JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Action: "sts:AssumeRole",
        Effect: "Allow",
        Sid: "",
        Principal: {
          Service: "ecs-tasks.amazonaws.com",
        },
      },
    ],
  }),
  inlinePolicies: [
    {
      name: "allow_exec",
      policy: JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Action: [
              "ssmmessages:CreateControlChannel",
              "ssmmessages:CreateDataChannel",
              "ssmmessages:OpenControlChannel",
              "ssmmessages:OpenDataChannel",
            ],
            Resource: "*",
          },
        ],
      }),
    },
    {
      name: "allow_iam_secrets_access",
      policy: JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Action: ["secretsmanager:GetSecretValue"],
            Effect: "Allow",
            Resource: SCORER_SERVER_SSM_ARN,
          },
        ],
      }),
    },
  ],
  managedPolicyArns: [
    "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy",
  ],
  tags: {
    dpopp: "",
  },
});

const secrets = [
  {
    name: "SECRET_KEY",
    valueFrom: `${SCORER_SERVER_SSM_ARN}:SECRET_KEY::`,
  }
];
const environment = [
  {
    name: "DEBUG",
    value: "off",
  },
  {
    name: "DATABASE_URL",
    value: rdsConnectionUrl,
  },
  {
    name: "UI_DOMAIN",
    value: "scorer." + process.env["DOMAIN"],
  },
  {
    name: "ALLOWED_HOSTS",
    value: JSON.stringify([domain, "*"]),
  },
  {
    name: "CSRF_TRUSTED_ORIGINS",
    value: JSON.stringify([`https://${domain}`]),
  },
  {
    name: "CELERY_BROKER_URL",
    value: redisCacheOpsConnectionUrl,
  },
  {
    name: "CERAMIC_CACHE_CACAO_VALIDATION_URL",
    value: "http://localhost:8001/verify",
  },
];

//////////////////////////////////////////////////////////////
// Set up the Scorer ECS service
//////////////////////////////////////////////////////////////
const service = new awsx.ecs.FargateService("scorer", {
  cluster,
  desiredCount: 1,
  subnets: vpc.privateSubnetIds,
  taskDefinitionArgs: {
    executionRole: dpoppEcsRole,
    containers: {
      scorer: {
        image: dockerGtcPassportScorerImage,
        memory: 4096,
        cpu: 4000,
        portMappings: [httpsListener],
        command: [
          "gunicorn",
          "-w",
          "4",
          "-k",
          "uvicorn.workers.UvicornWorker",
          "scorer.asgi:application",
          "-b",
          "0.0.0.0:80",
        ],
        links: [],
        secrets: secrets,
        environment: environment,
        linuxParameters: {
          initProcessEnabled: true,
        },
      },
      verifier: {
        image: dockerGtcPassportVerifierImage,
        memory: 512,
        links: [],
        portMappings: [
          {
            containerPort: 8001,
            hostPort: 8001,
          },
        ],
        environment: [
          {
            name: "VERIFIER_PORT",
            value: "8001",
          },
        ],
        linuxParameters: {
          initProcessEnabled: true,
        },
      },
    },
  },
});

const ecsScorerServiceAutoscalingTarget = new aws.appautoscaling.Target(
  "scorer-autoscaling-target",
  {
    maxCapacity: 10,
    minCapacity: 2,
    resourceId: pulumi.interpolate`service/${cluster.cluster.name}/${service.service.name}`,
    scalableDimension: "ecs:service:DesiredCount",
    serviceNamespace: "ecs",
  }
);

const ecsScorerServiceAutoscaling = new aws.appautoscaling.Policy(
  "scorer-autoscaling-policy",
  {
    policyType: "TargetTrackingScaling",
    resourceId: ecsScorerServiceAutoscalingTarget.resourceId,
    scalableDimension: ecsScorerServiceAutoscalingTarget.scalableDimension,
    serviceNamespace: ecsScorerServiceAutoscalingTarget.serviceNamespace,
    targetTrackingScalingPolicyConfiguration: {
      predefinedMetricSpecification: {
        predefinedMetricType: "ECSServiceAverageCPUUtilization",
      },
      targetValue: 70,
      scaleInCooldown: 300,
      scaleOutCooldown: 300,
    },
  }
);

//////////////////////////////////////////////////////////////
// Set up the Celery Worker Secrvice
//////////////////////////////////////////////////////////////
const workerRole = new aws.iam.Role("scorer-bkgrnd-worker-role", {
  assumeRolePolicy: JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Action: "sts:AssumeRole",
        Effect: "Allow",
        Sid: "",
        Principal: {
          Service: "ecs-tasks.amazonaws.com",
        },
      },
    ],
  }),
  inlinePolicies: [
    {
      name: "allow_exec",
      policy: JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Action: [
              "ssmmessages:CreateControlChannel",
              "ssmmessages:CreateDataChannel",
              "ssmmessages:OpenControlChannel",
              "ssmmessages:OpenDataChannel",
            ],
            Resource: "*",
          },
        ],
      }),
    },
    {
      name: "allow_iam_secrets_access",
      policy: JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Action: ["secretsmanager:GetSecretValue"],
            Effect: "Allow",
            Resource: SCORER_SERVER_SSM_ARN,
          },
        ],
      }),
    },
  ],
  managedPolicyArns: [
    "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy",
  ],
  tags: {
    dpopp: "",
  },
});

const celeryWorker = new awsx.ecs.FargateService("scorer-bkgrnd-worker", {
  cluster,
  desiredCount: 2,
  subnets: vpc.privateSubnetIds,
  taskDefinitionArgs: {
    executionRole: workerRole,
    containers: {
      worker1: {
        image: dockerGtcPassportScorerImage,
        command: ["celery", "-A", "scorer", "worker", "-l", "DEBUG", "-c", "8"],
        memory: 4096,
        cpu: 2000,
        portMappings: [],
        secrets: secrets,
        environment: environment,
        dependsOn: [],
        links: [],
      },
    },
  },
});

const ecsScorerWorkerAutoscalingTarget = new aws.appautoscaling.Target(
  "scorer-worker-autoscaling-target",
  {
    maxCapacity: 10,
    minCapacity: 2,
    resourceId: pulumi.interpolate`service/${cluster.cluster.name}/${celeryWorker.service.name}`,
    scalableDimension: "ecs:service:DesiredCount",
    serviceNamespace: "ecs",
  }
);

const ecsScorerWorkerAutoscaling = new aws.appautoscaling.Policy(
  "scorer-worker-autoscaling-policy",
  {
    policyType: "TargetTrackingScaling",
    resourceId: ecsScorerWorkerAutoscalingTarget.resourceId,
    scalableDimension: ecsScorerWorkerAutoscalingTarget.scalableDimension,
    serviceNamespace: ecsScorerWorkerAutoscalingTarget.serviceNamespace,
    targetTrackingScalingPolicyConfiguration: {
      predefinedMetricSpecification: {
        predefinedMetricType: "ECSServiceAverageCPUUtilization",
      },
      targetValue: 80,
      scaleInCooldown: 300,
      scaleOutCooldown: 300,
    },
  }
);

//////////////////////////////////////////////////////////////
// Set up task to run migrations
//////////////////////////////////////////////////////////////
const taskMigrate = new awsx.ecs.FargateTaskDefinition(`scorer-run-migrate`, {
  executionRole: dpoppEcsRole,
  containers: {
    web: {
      image: dockerGtcPassportScorerImage,
      command: ["python", "manage.py", "migrate"],
      memory: 4096,
      cpu: 2000,
      portMappings: [],
      secrets: secrets.concat([
        {
          name: "DJANGO_SUPERUSER_USERNAME",
          valueFrom: `${SCORER_SERVER_SSM_ARN}:DJANGO_SUPERUSER_USERNAME::`,
        },
        {
          name: "DJANGO_SUPERUSER_EMAIL",
          valueFrom: `${SCORER_SERVER_SSM_ARN}:DJANGO_SUPERUSER_EMAIL::`,
        },
        {
          name: "DJANGO_SUPERUSER_PASSWORD",
          valueFrom: `${SCORER_SERVER_SSM_ARN}:DJANGO_SUPERUSER_PASSWORD::`,
        },
      ]),
      environment: environment,
      dependsOn: [],
      links: [],
    },
  },
});

export const taskMigrateDefinition = taskMigrate.taskDefinition.id;

//////////////////////////////////////////////////////////////
// Set up task to create superuser
//////////////////////////////////////////////////////////////
const task = new awsx.ecs.FargateTaskDefinition(`scorer-run-createsuperuser`, {
  executionRole: dpoppEcsRole,
  containers: {
    web: {
      image: dockerGtcPassportScorerImage,
      command: ["python", "manage.py", "createsuperuser", "--noinput"],
      memory: 4096,
      cpu: 2000,
      portMappings: [],
      secrets: secrets.concat([
        {
          name: "DJANGO_SUPERUSER_USERNAME",
          valueFrom: `${SCORER_SERVER_SSM_ARN}:DJANGO_SUPERUSER_USERNAME::`,
        },
        {
          name: "DJANGO_SUPERUSER_EMAIL",
          valueFrom: `${SCORER_SERVER_SSM_ARN}:DJANGO_SUPERUSER_EMAIL::`,
        },
        {
          name: "DJANGO_SUPERUSER_PASSWORD ",
          valueFrom: `${SCORER_SERVER_SSM_ARN}:DJANGO_SUPERUSER_PASSWORD::`,
        },
      ]),
      environment: environment,
      dependsOn: [],
      links: [],
    },
  },
});

export const taskDefinition = task.taskDefinition.id;

const secgrp = new aws.ec2.SecurityGroup(`scorer-run-migrations-task`, {
  description: "gitcoin-ecs-task",
  vpcId: vpc.id,
  ingress: [
    { protocol: "tcp", fromPort: 22, toPort: 22, cidrBlocks: ["0.0.0.0/0"] },
    { protocol: "tcp", fromPort: 80, toPort: 80, cidrBlocks: ["0.0.0.0/0"] },
  ],
  egress: [
    {
      protocol: "-1",
      fromPort: 0,
      toPort: 0,
      cidrBlocks: ["0.0.0.0/0"],
    },
  ],
});

export const securityGroupForTaskDefinition = secgrp.id;

//////////////////////////////////////////////////////////////
// Set up EC2 instance
//      - it is intended to be used for troubleshooting
//////////////////////////////////////////////////////////////

const ubuntu = aws.ec2.getAmi({
  mostRecent: true,
  filters: [
    {
      name: "name",
      values: ["ubuntu/images/hvm-ssd/ubuntu-focal-20.04-amd64-server-*"],
    },
    {
      name: "virtualization-type",
      values: ["hvm"],
    },
  ],
  owners: ["099720109477"],
});

// Script to install docker in ec2 instance
const ec2InitScript = `#!/bin/bash

# Installing docker in ubuntu
# Instructions taken from here: https://docs.docker.com/engine/install/ubuntu/

mkdir /var/log/gitcoin
echo $(date) "Starting installation of docker" >> /var/log/gitcoin/init.log
apt-get remove docker docker-engine docker.io containerd runc

apt-get update

apt-get install -y \
  ca-certificates \
  curl \
  gnupg \
  lsb-release

curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /usr/share/keyrings/docker-archive-keyring.gpg

echo \
"deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/docker-archive-keyring.gpg] https://download.docker.com/linux/ubuntu \
$(lsb_release -cs) stable" | tee /etc/apt/sources.list.d/docker.list > /dev/null

apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io awscli
mkdir /var/log/gitcoin
echo $(date) "Finished installation of docker" >> /var/log/gitcoin/init.log

`;

const web = new aws.ec2.Instance("Web", {
  ami: ubuntu.then((ubuntu) => ubuntu.id),
  associatePublicIpAddress: true,
  instanceType: "t3.medium",
  subnetId: vpcPublicSubnetId1.then(),

  vpcSecurityGroupIds: [secgrp.id],
  rootBlockDevice: {
    volumeSize: 50,
  },
  tags: {
    Name: "Passport Scorer - troubleshooting instance",
  },
  userData: ec2InitScript,
});

export const ec2PublicIp = web.publicIp;
export const dockrRunCmd = pulumi.secret(
  pulumi.interpolate`docker run -it -e 'DATABASE_URL=${rdsConnectionUrl}' -e 'CELERY_BROKER_URL=${redisCacheOpsConnectionUrl}' '${dockerGtcPassportScorerImage}' bash`
);
