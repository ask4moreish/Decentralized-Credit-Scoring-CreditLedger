import React from 'react';
import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import { 
  Shield, 
  TrendingUp, 
  Users, 
  Globe, 
  ArrowRight, 
  Star,
  CheckCircle,
  BarChart3
} from 'lucide-react';

import { useWalletStore } from '../store/walletStore';
import { Button } from '../components/Button';
import { Card } from '../components/Card';

export function HomePage() {
  const { isConnected, publicKey, connect, isConnecting } = useWalletStore();

  const features = [
    {
      icon: Shield,
      title: 'Decentralized Credit',
      description: 'Build your credit score on-chain using alternative data sources like mobile payments and savings behavior.',
    },
    {
      icon: TrendingUp,
      title: 'Collateral-Free Loans',
      description: 'Access DeFi loans without collateral based on your on-chain credit reputation.',
    },
    {
      icon: Users,
      title: 'Community Vouching',
      description: 'Get vouched by trusted community members to boost your credit score.',
    },
    {
      icon: Globe,
      title: 'Stellar Blockchain',
      description: 'Fast, low-cost transactions on the Stellar network for global accessibility.',
    },
  ];

  const stats = [
    { label: 'Active Users', value: '10,000+', icon: Users },
    { label: 'Loans Issued', value: '$2.5M', icon: TrendingUp },
    { label: 'Countries', value: '45+', icon: Globe },
    { label: 'Success Rate', value: '94%', icon: CheckCircle },
  ];

  return (
    <div className="min-h-screen">
      {/* Hero Section */}
      <section className="relative overflow-hidden bg-gradient-to-br from-blue-50 to-indigo-100 py-20">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="text-center">
            <motion.h1
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5 }}
              className="text-4xl md:text-6xl font-bold text-gray-900 mb-6"
            >
              CreditLedger
            </motion.h1>
            <motion.p
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5, delay: 0.1 }}
              className="text-xl md:text-2xl text-gray-600 mb-8 max-w-3xl mx-auto"
            >
              Build your on-chain credit score with alternative data and access 
              collateral-free DeFi loans on the Stellar blockchain.
            </motion.p>
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5, delay: 0.2 }}
              className="flex flex-col sm:flex-row gap-4 justify-center"
            >
              {!isConnected ? (
                <Button
                  onClick={connect}
                  disabled={isConnecting}
                  size="lg"
                  className="bg-indigo-600 hover:bg-indigo-700"
                >
                  {isConnecting ? 'Connecting...' : 'Connect Wallet'}
                </Button>
              ) : (
                <Link to="/dashboard">
                  <Button size="lg" className="bg-indigo-600 hover:bg-indigo-700">
                    Go to Dashboard
                    <ArrowRight className="ml-2 h-5 w-5" />
                  </Button>
                </Link>
              )}
              <Link to="/about">
                <Button variant="outline" size="lg">
                  Learn More
                </Button>
              </Link>
            </motion.div>
          </div>
        </div>
      </section>

      {/* Stats Section */}
      <section className="py-16 bg-white">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="grid grid-cols-1 md:grid-cols-4 gap-8">
            {stats.map((stat, index) => (
              <motion.div
                key={stat.label}
                initial={{ opacity: 0, y: 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.5, delay: index * 0.1 }}
                className="text-center"
              >
                <div className="flex justify-center mb-4">
                  <stat.icon className="h-8 w-8 text-indigo-600" />
                </div>
                <div className="text-3xl font-bold text-gray-900 mb-2">{stat.value}</div>
                <div className="text-gray-600">{stat.label}</div>
              </motion.div>
            ))}
          </div>
        </div>
      </section>

      {/* Features Section */}
      <section className="py-20 bg-gray-50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="text-center mb-16">
            <h2 className="text-3xl md:text-4xl font-bold text-gray-900 mb-4">
              Why Choose CreditLedger?
            </h2>
            <p className="text-xl text-gray-600 max-w-3xl mx-auto">
              Our decentralized credit scoring system uses alternative data to provide 
              financial access to the unbanked and underbanked worldwide.
            </p>
          </div>
          
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-8">
            {features.map((feature, index) => (
              <motion.div
                key={feature.title}
                initial={{ opacity: 0, y: 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.5, delay: index * 0.1 }}
              >
                <Card className="h-full p-6 text-center hover:shadow-lg transition-shadow">
                  <feature.icon className="h-12 w-12 text-indigo-600 mx-auto mb-4" />
                  <h3 className="text-xl font-semibold text-gray-900 mb-3">
                    {feature.title}
                  </h3>
                  <p className="text-gray-600">
                    {feature.description}
                  </p>
                </Card>
              </motion.div>
            ))}
          </div>
        </div>
      </section>

      {/* How It Works Section */}
      <section className="py-20 bg-white">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="text-center mb-16">
            <h2 className="text-3xl md:text-4xl font-bold text-gray-900 mb-4">
              How It Works
            </h2>
            <p className="text-xl text-gray-600 max-w-3xl mx-auto">
              Get started in minutes and build your credit score step by step.
            </p>
          </div>
          
          <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
            {[
              {
                step: '1',
                title: 'Connect Wallet',
                description: 'Connect your Stellar wallet to create your on-chain identity.',
              },
              {
                step: '2',
                title: 'Build Credit',
                description: 'Add payment history, savings data, and get community vouches.',
              },
              {
                step: '3',
                title: 'Access Loans',
                description: 'Apply for collateral-free loans based on your credit score.',
              },
            ].map((item, index) => (
              <motion.div
                key={item.step}
                initial={{ opacity: 0, y: 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.5, delay: index * 0.1 }}
                className="relative"
              >
                <div className="flex items-center mb-4">
                  <div className="flex items-center justify-center w-12 h-12 bg-indigo-600 text-white rounded-full font-bold text-lg mr-4">
                    {item.step}
                  </div>
                  <h3 className="text-xl font-semibold text-gray-900">{item.title}</h3>
                </div>
                <p className="text-gray-600 ml-16">{item.description}</p>
                {index < 2 && (
                  <div className="hidden md:block absolute top-6 left-full w-full h-0.5 bg-gray-300 -ml-8" />
                )}
              </motion.div>
            ))}
          </div>
        </div>
      </section>

      {/* CTA Section */}
      <section className="py-20 bg-indigo-600">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
          <motion.h2
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            className="text-3xl md:text-4xl font-bold text-white mb-4"
          >
            Ready to Build Your On-Chain Credit?
          </motion.h2>
          <motion.p
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.1 }}
            className="text-xl text-indigo-200 mb-8 max-w-2xl mx-auto"
          >
            Join thousands of users accessing financial services through decentralized credit scoring.
          </motion.p>
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.2 }}
          >
            {!isConnected ? (
              <Button
                onClick={connect}
                disabled={isConnecting}
                size="lg"
                variant="outline"
                className="bg-white text-indigo-600 hover:bg-gray-50"
              >
                {isConnecting ? 'Connecting...' : 'Get Started Now'}
              </Button>
            ) : (
              <Link to="/dashboard">
                <Button
                  size="lg"
                  variant="outline"
                  className="bg-white text-indigo-600 hover:bg-gray-50"
                >
                  View Dashboard
                  <ArrowRight className="ml-2 h-5 w-5" />
                </Button>
              </Link>
            )}
          </motion.div>
        </div>
      </section>
    </div>
  );
}
