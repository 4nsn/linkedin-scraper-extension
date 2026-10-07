# LinkedIn Job Scraper (Chrome extension)

A Chrome extension that searches LinkedIn's public job listings by title and location, removes senior-level titles and duplicates, and shows the results in a table you can filter and export as CSV.

## Install
1. Download or clone this repo.
2. Go to `chrome://extensions` and turn on **Developer mode**.
3. Click **Load unpacked** and select the repo folder.
4. Pin the extension and click its icon to start a search.

## Usage
- Enter job titles and locations (one per line). Use `UK` for the whole country.
- Choose how recent the jobs should be, the experience level and words to exclude.
- Click **Search jobs**. Results appear as they're found. Use Stop to end early, or Download CSV when done.

## Notes
- It uses LinkedIn's public guest endpoint, so no login is needed. LinkedIn may change it or rate limit requests at any time.
- It waits 3 seconds between requests. Use it sparingly and check LinkedIn's terms of use.
- Related Python version: [linkedin-scraper](https://github.com/4nsn/linkedin-scraper)
