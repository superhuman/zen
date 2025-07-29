import Util from './util'
import { listTests, workTests } from './lambda.js'
import type { Zen } from './index'

class ChromeActions {
  headed: boolean
  zen: Zen

  constructor({ headed = false, zen }: { zen: Zen; headed?: boolean }) {
    this.headed = headed
    this.zen = zen
  }

  async listTests() {
    const awsRegion = this.zen.config.aws.region
    const sessionId = this.zen.config.sessionId

    if (this.headed) {
      return listTests({
        awsRegion,
        sessionId,
        headed: this.headed,
      })
    } else {
      return this.zen.lambdaInvoke(this.zen.config.lambdaNames.listTests, {
        awsRegion,
        sessionId,
      })
    }
  }

  async workTests({ testNames }) {
    const sessionId = this.zen.config.sessionId
    const awsRegion = this.zen.config.aws.region

    try {
      let results
      if (this.headed) {
        results = await workTests({
          awsRegion,
          testNames,
          sessionId,
          headed: this.headed,
        })
      } else {
        results = await this.zen.lambdaInvoke(
          this.zen.config.lambdaNames.workTests,
          {
            testNames,
            sessionId,
            awsRegion,
          }
        )
      }
      return results
    } catch (e) {
      return testNames.map((name: string) => {
        return {
          fullName: name,
          error: `zen failed to run this group: ${e.stack || e.message}`,
          frameworkError: true,
          time: 0,
        }
      })
    }
  }
}

export default ChromeActions
