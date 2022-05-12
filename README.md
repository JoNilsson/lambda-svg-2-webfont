# ASW ƛ S3 - Convert SVG to WebFont
<hr>

Generating and hosting webfonts is one of the sucky parts of doing web-dev. 
This **AWS Lambda function** makes it easy. 

- Watches an S3 bucket for new SVG file(s)
- Upload triggers generation of a complete new webfont (ttf, woff, eot, html, css, json)
- Uses the folder structure in the S3 bucket to allow management of multiple webfonts!

## Requirements

1. [Serverless framework >1.1.0](https://serverless.com/)

## Getting started

1. Clone this repository
2. Create a `serverless.yml` file and enter a new and unique
   `bucket_name`, `region` and `stage`
3. `sls deploy`
4. Create a folder on your s3 bucket and put some SVG files in it
5. Enjoy! :-)


🕳🐇

