import { Logger, SubgraphDeploymentID } from '@graphprotocol/common-ts'
import PQueue from 'p-queue'

import { AgentConfig, Subgraph } from './types'
import { Indexer } from './indexer'
import { Network } from './network'

const delay = async (ms: number) => {
  await new Promise(resolve => setTimeout(resolve, ms))
}

const loop = async (f: () => Promise<void>, interval: number) => {
  // eslint-disable-next-line no-constant-condition
  while (true) {
    await f()
    await delay(interval)
  }
}

export class Agent {
  indexer: Indexer
  network: Network
  logger: Logger
  networkSubgraphDeployment: SubgraphDeploymentID

  private constructor(
    logger: Logger,
    indexer: Indexer,
    network: Network,
    networkSubgraphDeployment: SubgraphDeploymentID,
  ) {
    this.logger = logger
    this.indexer = indexer
    this.network = network
    this.networkSubgraphDeployment = networkSubgraphDeployment
  }

  static async create(config: AgentConfig): Promise<Agent> {
    const indexer = new Indexer(
      config.adminEndpoint,
      config.statusEndpoint,
      config.logger,
    )
    const network = await Network.create(
      config.logger,
      config.ethereumProvider,
      config.network,
      config.publicIndexerUrl,
      config.queryEndpoint,
      config.indexerGeoCoordinates,
      config.mnemonic,
      config.networkSubgraphDeployment,
      config.connextNode,
    )
    return new Agent(
      config.logger,
      indexer,
      network,
      config.networkSubgraphDeployment,
    )
  }

  async setupIndexer(): Promise<void> {
    this.logger.info(
      `Connecting to indexer and ensuring registration and stake on the network`,
    )
    await this.indexer.connect()
    await this.network.register()
    await this.network.ensureMinimumStake(100000)
    this.logger.info(`Indexer active and registered on network`)
  }

  async start(): Promise<void> {
    this.logger.info(`Agent booted up`)

    await this.indexer.ensure(
      `${this.networkSubgraphDeployment.ipfsHash.slice(
        0,
        23,
      )}/${this.networkSubgraphDeployment.ipfsHash.slice(23)}`,
      this.networkSubgraphDeployment,
    )
    await this.network.allocate(this.networkSubgraphDeployment)

    this.logger.info(`Polling for subgraph changes`)
    await loop(async () => {
      const indexerDeployments = await this.indexer.subgraphDeployments()
      const networkSubgraphs = await this.network.subgraphDeploymentsWorthIndexing()

      const deploymentsToIndex: SubgraphDeploymentID[] = [
        ...networkSubgraphs.map(
          ({ subgraphDeploymentID }) => subgraphDeploymentID,
        ),

        // Ensure the network subgraph deployment _always_ keeps indexing
        this.networkSubgraphDeployment,
      ]

      await this.resolve(deploymentsToIndex, indexerDeployments)
    }, 5000)
  }

  async resolve(
    networkDeployments: SubgraphDeploymentID[],
    indexerDeployments: SubgraphDeploymentID[],
  ): Promise<void> {
    // Identify which subgraphs to deploy and which to remove
    let toDeploy = networkDeployments.filter(
      deployment =>
        !indexerDeployments.find(
          indexerDeployment => deployment.bytes32 === indexerDeployment.bytes32,
        ),
    )

    let toRemove = indexerDeployments.filter(
      deployment =>
        !networkDeployments.find(
          networkDeployment => deployment.bytes32 === networkDeployment.bytes32,
        ),
    )

    const uniqueDeploymentsOnly = (
      value: SubgraphDeploymentID,
      index: number,
      array: SubgraphDeploymentID[],
    ): boolean => array.findIndex(v => value.bytes32 === v.bytes32) === index

    // Ensure there are no duplicates in the deployments
    toDeploy = toDeploy.filter(uniqueDeploymentsOnly)
    toRemove = toRemove.filter(uniqueDeploymentsOnly)

    // Deploy/remove up to 20 subgraphs in parallel
    const queue = new PQueue({ concurrency: 1 })

    for (const deployment of toDeploy) {
      const name = `indexer-agent/${deployment.ipfsHash.slice(-10)}`

      queue.add(async () => {
        this.logger.info(`Begin indexing '${name}':'${deployment}'...`)

        // Ensure the deployment is deployed to the indexer
        await this.indexer.ensure(name, deployment)

        // Allocate stake on the deployment in the network
        await this.network.allocate(deployment)

        this.logger.info(`Now indexing '${name}':'${deployment}'`)
      })
    }

    for (const deployment of toRemove) {
      queue.add(() => this.indexer.remove(deployment))
    }

    await queue.onIdle()
  }
}
