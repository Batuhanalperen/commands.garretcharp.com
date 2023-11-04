import { Hono } from 'hono/quick'
import { timing, startTime, endTime } from 'hono/timing'
import { safe } from '../../utils'
import { getFormat, getFormattedData } from '../../utils/time'
import { getTwitchFollower, getTwitchUsers } from '../../utils/twitch'

const routes = new Hono<{ Bindings: Bindings }>()

routes.get('/followage/:streamer/:viewer', timing(), async c => {
	const { streamer, viewer } = c.req.param()

	if (streamer === '$(channel)') return c.text('$(channel) is a replacement for the streamers username in nightbot, if you do not use nightbot you need to use a variable that replaces to the streamer username in that bot.')
	if (viewer === '$(touser)' || viewer === '$(touser))') return c.text('$(touser) is a replacement for the viewers username in nightbot, if you do not use nightbot you need to use a variable that replaces to the viewer username in that bot.')

	if (streamer === '{StreamerUsername}') return c.text('You need to replace {StreamerUsername} with the streamers username.')
	if (viewer === '{ViewerUsername}') return c.text('You need to replace {ViewerUsername} with the viewers username.')

	startTime(c, 'users', 'Fetch Twitch Users')
	const response = await safe(
		getTwitchUsers({
			env: c.env,
			logins: [streamer.toLowerCase(), viewer.toLowerCase()],
			ctx: c.executionCtx
		})
	)
	endTime(c, 'users')

	if (!response.success) {
		const error = safe(() => JSON.parse(response.error.message))

		if (error.success && error.data.message.toLowerCase().includes('bad identifiers'))
			return c.text(`Could not get users from Twitch API, one or more of the usernames are not valid. Streamer: ${streamer}, Viewer: ${viewer}`)

		safe(() => {
			c.env.FollowageApp.writeDataPoint({
				blobs: ['commands/twitch/followage', `Could not get twitch users: ${response.error.message}`, streamer, viewer, '', c.req.raw.cf?.colo as string ?? ''],
				indexes: ['errors']
			})
		})

		return c.text(`Could not get users from Twitch API, please try again later and ensure the usernames are valid. Streamer: ${streamer}, Viewer: ${viewer}`)
	}

	const users = { streamer: response.data.get(streamer.toLowerCase()), viewer: response.data.get(viewer.toLowerCase()) }

	if (!users.streamer && !users.viewer) {
		safe(() => {
			c.env.FollowageApp.writeDataPoint({
				blobs: ['commands/twitch/followage', `Streamer twitch account ${streamer} was not found. And viewer account ${viewer} was not found.`, streamer, viewer, '', c.req.raw.cf?.colo as string ?? ''],
				indexes: ['errors']
			})
		})

		return c.text(`Could not find the following Twitch accounts: @${streamer}, @${viewer}.`)
	} else if (!users.streamer) {
		safe(() => {
			c.env.FollowageApp.writeDataPoint({
				blobs: ['commands/twitch/followage', `Streamer twitch account ${streamer} was not found`, streamer, viewer, '', c.req.raw.cf?.colo as string ?? ''],
				indexes: ['errors']
			})
		})

		return c.text(`Could not find a Twitch account for the streamer: @${streamer}.`)
	} else if (!users.viewer) {
		safe(() => {
			c.env.FollowageApp.writeDataPoint({
				blobs: ['commands/twitch/followage', `Viewer ${viewer} not found`, streamer, viewer, '', c.req.raw.cf?.colo as string ?? ''],
				indexes: ['errors']
			})
		})

		return c.text(`Could not find a Twitch account for the user: @${viewer}`)
	}

	const moderatorId = c.req.query('moderatorId')

	startTime(c, 'follow', 'Fetch Twitch Follower')
	const follow = await safe(
		getTwitchFollower({
			env: c.env,
			streamer: users.streamer,
			viewer: users.viewer,
			moderator: moderatorId
		})
	)
	endTime(c, 'follow')

	if (!follow.success) {
		if (follow.error instanceof Error) {
			if (follow.error.message.toLowerCase().includes('auth was revoked')) {
				if (moderatorId) return c.text('The moderator provided in the request has revoked access to the application, please have them login to the application to use this command.')
				return c.text('The authentication token for the streamer has been revoked, please have them login to the application to use this command.')
			}

			if (follow.error.message.toLowerCase().includes('not logged in')) {
				if (moderatorId) return c.text('The moderator provided in the request is not logged into the application, please have them login to the application to use this command.')
				return c.text('In order to use this API the streamer must login to the application.')
			}

			if (follow.error.message.toLowerCase().includes('not a moderator for the broadcaster')) {
				return c.text('The moderatorId provided in the request is not a moderator for the streamer. Please ensure the user is a moderator or remove the moderatorId from the request.')
			}
		}

		safe(() => {
			c.env.FollowageApp.writeDataPoint({
				blobs: ['commands/twitch/followage', `Could not get follower data: ${follow.error.message}`, streamer, viewer, moderatorId ?? '', c.req.raw.cf?.colo as string ?? ''],
				indexes: ['errors']
			})
		})

		return c.text('Unable to get the users followage due to an error internally or with the Twitch API. Authenticating again may fix this issue, or try again later.')
	}

	const format = getFormat(c.req.query('format'))

	safe(() => {
		c.env.FollowageApp.writeDataPoint({
			blobs: ['twitch', 'followage', users.streamer!.id, users.streamer!.login, users.viewer!.id, users.viewer!.login, moderatorId ?? '', c.req.raw.cf?.colo as string ?? ''],
			indexes: ['commands']
		})

		if (format !== 'ymdhis')
			c.env.FollowageApp.writeDataPoint({
				blobs: ['twitch/followage/format', format, users.streamer!.id, users.streamer!.login],
				indexes: ['feature_usage']
			})
	})

	if (!follow.data) return c.text(`@${users.viewer.login} is not following @${users.streamer.login}.`)

	const diff = Math.abs(Date.now() - new Date(follow.data.followed_at).getTime()) / 1000
	const data = getFormattedData(diff, format), parts = []

	// TODO: Language support?

	if (data.years && data.years > 0) parts.push(`${data.years} year${data.years === 1 ? '' : 's'}`)
	if (data.months && data.months > 0) parts.push(`${data.months} month${data.months === 1 ? '' : 's'}`)
	if (data.weeks && data.weeks > 0) parts.push(`${data.weeks} week${data.weeks === 1 ? '' : 's'}`)
	if (data.days && data.days > 0) parts.push(`${data.days} day${data.days === 1 ? '' : 's'}`)
	if (data.hours && data.hours > 0) parts.push(`${data.hours} hour${data.hours === 1 ? '' : 's'}`)
	if (data.minutes && data.minutes > 0) parts.push(`${data.minutes} minute${data.minutes === 1 ? '' : 's'}`)
	if (data.seconds && data.seconds > 0) parts.push(`${data.seconds} second${data.seconds === 1 ? '' : 's'}`)

	return c.text(`@${users.viewer.login} has been following @${users.streamer.login} for ${parts.join(', ')}.`)
})

export default routes
