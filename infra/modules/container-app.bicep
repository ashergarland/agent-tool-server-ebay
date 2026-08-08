@description('Name of the Container Apps environment.')
param environmentName string

@description('Name of the connector container app.')
param appName string

@description('Azure region.')
param location string

@description('Tags applied to all resources in this module.')
param tags object = {}

@description('Resource id of the Log Analytics workspace for container logs.')
param logAnalyticsWorkspaceId string

@description('Resource id of the user-assigned managed identity.')
param identityId string

@description('Fully qualified container image reference.')
param image string

@description('Login server of the container registry the image is pulled from.')
param registryLoginServer string

@description('Key Vault secret URI holding the connector API key.')
param apiKeySecretUri string

@description('Key Vault secret URI holding the eBay application client id (App ID).')
param ebayClientIdSecretUri string

@description('Key Vault secret URI holding the eBay application client secret (Cert ID).')
param ebayClientSecretSecretUri string

@description('Public base URL advertised in the generated OpenAPI document.')
param publicBaseUrl string = ''

@description('Which eBay environment the connector talks to.')
@allowed(['production', 'sandbox'])
param ebayEnvironment string = 'production'

@description('Default eBay marketplace for tools that do not specify one.')
param ebayMarketplaceId string = 'EBAY_US'

@description('Two letter country code used as the buyer context for shipping quotes.')
param ebayDeliveryCountry string = ''

@description('Postal code used as the buyer context for shipping quotes.')
param ebayDeliveryPostalCode string = ''

@description('Log level for the connector.')
@allowed(['fatal', 'error', 'warn', 'info', 'debug', 'trace'])
param logLevel string = 'info'

@description('Minimum number of replicas.')
@minValue(0)
param minReplicas int = 1

@description('Maximum number of replicas.')
@minValue(1)
param maxReplicas int = 3

resource logAnalytics 'Microsoft.OperationalInsights/workspaces@2023-09-01' existing = {
  name: last(split(logAnalyticsWorkspaceId, '/'))
}

resource environment 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: environmentName
  location: location
  tags: tags
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logAnalytics.properties.customerId
        sharedKey: logAnalytics.listKeys().primarySharedKey
      }
    }
    zoneRedundant: false
  }
}

resource app 'Microsoft.App/containerApps@2024-03-01' = {
  name: appName
  location: location
  tags: tags
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${identityId}': {}
    }
  }
  properties: {
    environmentId: environment.id
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        external: true
        targetPort: 8080
        transport: 'auto'
        allowInsecure: false
        traffic: [
          {
            latestRevision: true
            weight: 100
          }
        ]
      }
      registries: [
        {
          server: registryLoginServer
          identity: identityId
        }
      ]
      secrets: [
        {
          name: 'connector-api-key'
          keyVaultUrl: apiKeySecretUri
          identity: identityId
        }
        {
          name: 'ebay-client-id'
          keyVaultUrl: ebayClientIdSecretUri
          identity: identityId
        }
        {
          name: 'ebay-client-secret'
          keyVaultUrl: ebayClientSecretSecretUri
          identity: identityId
        }
      ]
    }
    template: {
      containers: [
        {
          name: 'connector'
          image: image
          resources: {
            cpu: json('0.5')
            memory: '1Gi'
          }
          env: [
            { name: 'NODE_ENV', value: 'production' }
            { name: 'PORT', value: '8080' }
            { name: 'LOG_LEVEL', value: logLevel }
            { name: 'SERVICE_NAME', value: appName }
            { name: 'PUBLIC_BASE_URL', value: publicBaseUrl }
            { name: 'AUTH_MODE', value: 'api-key' }
            { name: 'API_KEYS', secretRef: 'connector-api-key' }
            { name: 'EBAY_CLIENT_ID', secretRef: 'ebay-client-id' }
            { name: 'EBAY_CLIENT_SECRET', secretRef: 'ebay-client-secret' }
            { name: 'EBAY_ENVIRONMENT', value: ebayEnvironment }
            { name: 'EBAY_MARKETPLACE_ID', value: ebayMarketplaceId }
            { name: 'EBAY_DELIVERY_COUNTRY', value: ebayDeliveryCountry }
            { name: 'EBAY_DELIVERY_POSTAL_CODE', value: ebayDeliveryPostalCode }
          ]
          probes: [
            {
              type: 'Liveness'
              httpGet: {
                path: '/health'
                port: 8080
              }
              initialDelaySeconds: 10
              periodSeconds: 30
            }
            {
              type: 'Readiness'
              httpGet: {
                path: '/health'
                port: 8080
              }
              initialDelaySeconds: 5
              periodSeconds: 10
            }
          ]
        }
      ]
      scale: {
        minReplicas: minReplicas
        maxReplicas: maxReplicas
        rules: [
          {
            name: 'http-scale'
            http: {
              metadata: {
                concurrentRequests: '20'
              }
            }
          }
        ]
      }
    }
  }
}

output fqdn string = app.properties.configuration.ingress.fqdn
output appName string = app.name
output environmentId string = environment.id
